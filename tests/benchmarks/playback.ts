/** Sustained replay of installed GridKit output, including plots below the scroll fold. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { pause, testHost, until, VIEWPORT, visible, VM } from '../vscode/harness.js'

export async function run() {
  const bench = await testHost()
  try {
    assert.ok(await bench.gridkit(), 'Installed GridKit is required')
    await vscode.workspace
      .getConfiguration('gridkitStudio')
      .update('accessibility.motion', 'full', vscode.ConfigurationTarget.Global)
    await until(
      () => bench.session.settings['accessibility.motion'] === 'full',
      'Full motion enabled',
    )
    bench.studio.record(bench.key, [{ from: 'Bus', select: ['Vm', 'Va'] }])
    bench.session.values = { tmax: 2, dt_monitor: 0.005 }
    await vscode.commands.executeCommand('gridkitStudio.startSimulation', bench.uri)
    await until(() => bench.session.run?.state === 'complete', 'GridKit completes', 180_000)
    // Two whole-case plots plus eight individual traces force a scrollable panel.
    bench.session.plots = [
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Va' },
      ...bench.source.buses
        .slice(0, 8)
        .map((bus) => ({ from: 'Bus', field: 'Vm', id: `Bus/${bus.number}` })),
    ]
    bench.studio.changed.fire(bench.key)
    const monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await until(
      () =>
        monitor
          .locator('canvas')
          .count()
          .then((n) => n === 10),
      'ten plots',
    )
    type Sample = {
      frames: number
      visible: boolean
      historyBytes: number
      segments: number
      refining: boolean
      at?: number
      lastFrame: number
      paused: boolean
      camera: { x: number[]; y: number[] }
      gpu: { submissions: number; queries: number; uploadedBytes: number }
    }
    const sample = () =>
      monitor.evaluate(`Array.from(document.querySelectorAll('canvas')).map(c => {
      const p = c.gridkitPlot?.(); const r = c.getBoundingClientRect();
      return { ...p, visible: r.bottom > 0 && r.top < innerHeight };
    })`) as Promise<Sample[]>
    await pause(1500)
    const before = await sample()
    const { transport } = bench.session
    transport.setLoop('wrap')
    transport.seek(0)
    transport.play()
    const started = performance.now()
    const samples = []
    for (let i = 0; i < Number(process.env.GRIDKIT_PLAYBACK_SECONDS ?? 30) * 2; i++) {
      await pause(500)
      samples.push(await sample())
    }
    transport.pause()
    const after = samples.at(-1)!
    const report = {
      result: { frames: bench.session.run!.frames, domain: bench.session.run!.domain },
      plots: after.map((plot, i) => ({
        visible: plot.visible,
        frames: plot.frames - before[i]!.frames,
        historyBytes: plot.historyBytes,
      })),
      gpu: after[0]?.gpu,
      elapsedMs: performance.now() - started,
      gpuBefore: before[0]?.gpu,
      errors: bench.studio.errors,
      samples,
    }
    await writeFile(join(bench.output, 'tests', 'playback.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ plots: report.plots, gpu: report.gpu, errors: report.errors }))
    assert.deepEqual(bench.studio.errors, [])
    for (let i = 0; i < after.length; i++) {
      if (!after[i]!.visible) {
        assert.equal(after[i]!.frames, before[i]!.frames, 'Offscreen plots must not render')
        continue
      }
      assert.ok(after[i]!.frames > before[i]!.frames + 10, 'Visible plot must keep presenting')
      for (let j = 1; j < samples.length; j++)
        assert.ok(
          samples[j]![i]!.frames > samples[j - 1]![i]!.frames,
          'No half-second playback freeze',
        )
      assert.deepEqual(
        after[i]!.camera.x,
        bench.session.run!.span,
        'Configured interval stays fixed',
      )
    }
    // Every sampled frame uses the existing history; the cursor must not query the model again.
    assert.equal(
      after[0]!.gpu.queries,
      before[0]!.gpu.queries,
      'Replay reuses model/history caches',
    )
    const seek = async (t: number) => {
      transport.seek(t)
      await until(
        async () =>
          (await sample())
            .filter((p) => p.visible)
            .every((p) => Math.abs((p.at ?? -1) - t) < 0.001),
        'all visible plots present the seek',
      )
    }
    for (const t of [1.8, 0.1, 1.2, 0.5]) await seek(t)
    // A color mapping keeps the whole-run normalization during seeks and resizing.
    const unmapped = (await sample())[0]!.segments
    bench.studio.bind(bench.key, VM, ['vertexColor'])
    await until(
      async () =>
        monitor.evaluate(`!!document.querySelector('canvas').gridkitPlot().traces.plotted.color`),
      'mapping applied',
    )
    const domain = () =>
      monitor.evaluate(`document.querySelector('canvas').gridkitPlot().traces.plotted.color.domain`)
    const range = await domain()
    assert.deepEqual(range, bench.session.run!.domains?.Bus?.Vm)
    // Config changes precede presentation. Let the one-time switch to coverage finish.
    await until(async () => {
      const plot = (await sample())[0]!
      return plot.segments > unmapped && !plot.refining
    }, 'mapped history finishes')
    const normalized = (await sample())[0]!
    const originalRun = bench.session.run!
    const originalPixels = await monitor.locator('canvas').first().screenshot()
    for (let i = 1; i <= 12; i++) {
      const next = [0.4 - i * 0.01, 1.6 + i * 0.01]
      bench.session.run = {
        ...originalRun,
        domains: {
          ...originalRun.domains,
          Bus: { ...originalRun.domains?.Bus, Vm: next as [number, number] },
        },
      }
      bench.studio.changed.fire(bench.key)
      await until(
        async () =>
          JSON.stringify(await domain()) === JSON.stringify(next) &&
          (await sample())[0]!.frames > normalized.frames,
        'global live range recolors cached history',
      )
      await pause(80)
      const current = (await sample())[0]!
      assert.equal(current.segments, normalized.segments, 'Normalization draws no line again')
      assert.equal(
        current.gpu.queries,
        normalized.gpu.queries,
        'Normalization performs zero model queries',
      )
      assert.deepEqual(
        current.camera.x,
        normalized.camera.x,
        'Normalization keeps the configured interval',
      )
    }
    const recoloredPixels = await monitor.locator('canvas').first().screenshot()
    assert.notDeepEqual(recoloredPixels, originalPixels, 'Cached history visibly recolors')
    bench.session.run = originalRun
    bench.studio.changed.fire(bench.key)
    await until(
      async () => JSON.stringify(await domain()) === JSON.stringify(range),
      'original global range restored',
    )
    const oldPalette = await monitor.evaluate(
      `JSON.stringify(document.querySelector('canvas').gridkitPlot().traces.plotted.color.colormap)`,
    )
    await vscode.workspace
      .getConfiguration('gridkitStudio')
      .update('network.colormap', 'batlow', vscode.ConfigurationTarget.Global)
    await until(
      () =>
        monitor.evaluate<boolean>(
          `JSON.stringify(document.querySelector('canvas').gridkitPlot().traces.plotted.color.colormap) !== ${JSON.stringify(oldPalette)}`,
        ),
      'new colormap applied',
    )
    await pause(250)
    assert.equal(
      (await sample())[0]!.segments,
      normalized.segments,
      'Palette changes reuse history too',
    )

    // Corrupt one received batch. The view must reject the commit; the host must resend
    // a full base automatically even though this completed run has no new frames.
    await monitor.evaluate(`(() => {
      window.streamAttempts = [];
      window.streamEnds = [];
      let corrupt = true;
      window.streamFault = event => {
        const m = event.data;
        if (m?.kind === 'begin') window.streamAttempts.push({ stream: m.stream, base: m.base, append: m.append });
        if (m?.kind === 'end') window.streamEnds.push(m.stream);
        if (m?.kind === 'batch' && corrupt) {
          corrupt = false;
          // An extra stale-sequence batch poisons assembly without preventing the real
          // batch's receipt. This specifically tests commit rejection, not batch timeout.
          window.dispatchEvent(new MessageEvent('message', { data: { ...m, sequence: 0 } }));
        }
      };
      window.addEventListener('message', window.streamFault, true);
    })()`)
    const allPlots = bench.session.plots
    bench.session.plots = allPlots.filter((p) => p.field !== 'Va')
    bench.studio.changed.fire(bench.key)
    await until(
      () =>
        monitor.evaluate<boolean>(
          `window.streamAttempts.length >= 2 && window.streamEnds.includes(window.streamAttempts.at(-1).stream) && document.querySelector('canvas').gridkitPlot()?.visible && !document.querySelector('canvas').gridkitPlot()?.refining`,
        ),
      async () =>
        'rejected commit retries: ' +
        JSON.stringify({
          attempts: await monitor.evaluate('window.streamAttempts'),
          plots: await sample(),
          errors: bench.studio.errors,
        }),
    )
    const attempts =
      await monitor.evaluate<{ base: boolean; append: boolean }[]>('window.streamAttempts')
    assert.equal(attempts[1]!.base, true, 'Retry replaces the uncertain snapshot')
    assert.equal(attempts[1]!.append, false, 'Retry cannot duplicate an uncertain append')
    await monitor.evaluate(`window.removeEventListener('message', window.streamFault, true)`)
    // Fail after every batch was acknowledged but before final commit. The completed run
    // must still be retried. Lost commit receipts themselves are covered by StreamDelivery.
    await monitor.evaluate(`(() => {
      window.streamAttempts = [];
      window.streamEnds = [];
      window.streamFault = event => {
        const m = event.data;
        if (m?.kind === 'begin') {
          window.streamAttempts.push({ stream: m.stream, base: m.base, append: m.append });
        }
        if (m?.kind === 'end') window.streamEnds.push(m.stream);
      };
      window.addEventListener('message', window.streamFault, true);
    })()`)
    const originalCall = bench.studio.client.call
    let failBeforeCommit = true
    bench.studio.client.call = (async (...args: Parameters<typeof originalCall>) => {
      const result = await originalCall.apply(bench.studio.client, args)
      if (args[0] === 'batches' && failBeforeCommit) {
        failBeforeCommit = false
        throw Object.assign(new Error('Injected pre-commit timeout'), { code: 'timeout' })
      }
      return result
    }) as typeof originalCall
    try {
      bench.session.plots = allPlots
      bench.studio.changed.fire(bench.key)
      await until(
        async () =>
          (await monitor.evaluate<boolean>(
            'window.streamAttempts.length >= 2 && window.streamEnds.includes(window.streamAttempts.at(-1).stream)',
          )) &&
          (await sample()).filter((p) => p.visible).every((p) => p.historyBytes > 0 && !p.refining),
        async () =>
          'pre-commit timeout recovery: ' +
          JSON.stringify({
            attempts: await monitor.evaluate('window.streamAttempts'),
            plots: (await sample()).map((p) => ({
              frames: p.frames,
              visible: p.visible,
              refining: p.refining,
            })),
            errors: bench.studio.errors,
          }),
      )
    } finally {
      bench.studio.client.call = originalCall
    }
    const timedOut =
      await monitor.evaluate<{ base: boolean; append: boolean }[]>('window.streamAttempts')
    // A stream stopped before its end left the view as it was, so it is asked for again as it was.
    const asked = ({ base, append }: { base: boolean; append: boolean }) => ({ base, append })
    assert.deepEqual(
      asked(timedOut[1]!),
      asked(timedOut[0]!),
      'Retry asks again for what never committed',
    )
    await monitor.evaluate(`window.removeEventListener('message', window.streamFault, true)`)
    assert.deepEqual(
      bench.studio.errors,
      [],
      'Transient stream rejection is recovered without a terminal error',
    )
    bench.report.normalization = {
      changes: 12,
      segments: 0,
      modelQueries: 0,
      commitAttempts: attempts,
      timeoutAttempts: timedOut,
    }
    await seek(1.5)
    await bench.page.setViewportSize({ width: 1200, height: 800 })
    await seek(0.4)
    assert.deepEqual(await domain(), range)
    await bench.page.setViewportSize(VIEWPORT)
    // Scroll to cold plots, then hide and show the entire panel during playback.
    await monitor.evaluate(`document.querySelector('.monitor__lanes').scrollTop = 10000`)
    await until(async () => (await sample()).at(-1)!.visible, 'last lane visible')
    await seek(1)
    transport.play()
    await bench.show('case')
    await pause(500)
    const hidden = await sample()
    await pause(500)
    assert.deepEqual(
      (await sample()).map((p) => p.frames),
      hidden.map((p) => p.frames),
      'Hidden panel stops rendering',
    )
    await bench.show('monitor')
    await monitor.evaluate(`document.querySelector('.monitor__lanes').scrollTop = 0`)
    await until(
      async () => (await sample())[0]!.visible && !(await sample())[0]!.paused,
      'first lane resumes',
    )
    bench.studio.action.fire({
      uri: bench.key,
      view: 'monitor',
      command: 'signalRange',
      value: { plot: bench.session.plots[0], range: [0.5, 1.5] },
    })
    await until(
      async () => (await sample())[0]!.camera.y.join() === '0.5,1.5',
      'manual value range applied',
    )
    // Exercise the real device-loss path twice within the former 10-second cutoff.
    for (let loss = 0; loss < 2; loss++) {
      await monitor.evaluate(`(async () => {
        window.oldMonitorCanvas = document.querySelector('canvas');
        const device = await new Promise(resolve => {
          const original = GPUDevice.prototype.createCommandEncoder;
          GPUDevice.prototype.createCommandEncoder = function(...args) {
            GPUDevice.prototype.createCommandEncoder = original;
            resolve(this); return original.apply(this, args);
          };
        });
        device.destroy();
      })()`)
      await until(
        () =>
          monitor.evaluate<boolean>(
            `document.querySelector('canvas') !== window.oldMonitorCanvas && document.querySelector('canvas')?.gridkitPlot?.().frames > 2`,
          ),
        'device loss replaces the canvas and resumes presentation',
      )
      assert.deepEqual(
        (await sample())[0]!.camera.y,
        [0.5, 1.5],
        'GPU recovery preserves manual value range',
      )
    }
    await pause(300)
    const expected = bench.studio.errors.splice(0)
    // Explicit GPUDevice.destroy() may be classified as cancellation rather than a defect.
    assert.ok(
      expected.every((error) => /device|destroy|lost/i.test(error)),
      expected.join('\n'),
    )
    // A typed device failure during submission also replaces the lane, without leaving a stopped clock or blank plot.
    await monitor.evaluate(`(() => {
      window.oldMonitorCanvases = Array.from(document.querySelectorAll('canvas'));
      const original = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function(...args) {
        GPUQueue.prototype.submit = original;
        throw Object.assign(new Error('Injected playback render failure'), { code: 'device-lost' });
      };
    })()`)
    await until(
      () =>
        monitor.evaluate<boolean>(
          `Array.from(document.querySelectorAll('canvas')).some(c => !window.oldMonitorCanvases.includes(c) && c.gridkitPlot?.().frames > 2)`,
        ),
      'render failure replaces the lane and resumes presentation',
    )
    await pause(300)
    await until(() => bench.studio.errors.length > 0, 'render failure reported')
    assert.ok(
      bench.studio.errors
        .splice(0)
        .every((error) => /Injected playback render failure/.test(error)),
    )
    // A driver queue that never settles fills both in-flight slots without emitting an error.
    // Recovery must replace the shared GPU, not just remount a plot on the wedged queue.
    await monitor.evaluate(`(() => {
      window.oldMonitorCanvas = document.querySelector('canvas');
      window.stalledFrames = [];
      let left = 2;
      const original = GPUQueue.prototype.onSubmittedWorkDone;
      GPUQueue.prototype.onSubmittedWorkDone = function() {
        if (--left === 0) GPUQueue.prototype.onSubmittedWorkDone = original;
        return new Promise(resolve => window.stalledFrames.push(resolve));
      };
    })()`)
    await until(
      () =>
        monitor.evaluate<boolean>(
          `document.querySelector('canvas') !== window.oldMonitorCanvas && document.querySelector('canvas')?.gridkitPlot?.().frames > 2`,
        ),
      'stalled GPU queue is replaced and playback resumes',
    )
    await monitor.evaluate(`window.stalledFrames.forEach(resolve => resolve())`)
    await until(() => bench.studio.errors.length > 0, 'stalled presentation is reported')
    const stalled = bench.studio.errors.splice(0)
    assert.ok(stalled.some((error) => /stopped presenting/.test(error)))
    assert.ok(
      stalled.every((error) => /stopped presenting|device|destroy|closed/i.test(error)),
      stalled.join('\n'),
    )
    transport.pause()
    await seek(0.8)
    assert.deepEqual(await domain(), range)
    assert.deepEqual(
      (await sample())[0]!.camera.y,
      [0.5, 1.5],
      'Renderer recovery preserves manual value range',
    )
    bench.report.playback = { ...report, checksPassed: true }
    await bench.capture('recovered-playback')
    console.log(
      'Replay checks passed: Full motion, cached history, offscreen pause, seeks, fixed axes, normalization, resize, visibility, repeated GPU loss, render failure, stalled GPU queue.',
    )
  } finally {
    await bench.finish()
  }
}
