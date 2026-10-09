<script lang="ts">
  import type { Positions } from '@latkit/gpu'
  import type { VideoProgress, VideoWrite } from '@latkit/video'
  import { onMount } from 'svelte'

  import type { VideoView, ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import { CanvasGpu } from '../gpu.js'
  import { current, receiveRows, type Snapshot } from '../rows.js'
  import { exportNeeds, Samples } from '../samples.js'
  import { appearance } from '../theme.js'
  import Section from '../ui/Section.svelte'
  import Select from '../ui/Select.svelte'
  import Switch from '../ui/Switch.svelte'
  import { DEFAULTS, exportable, exportVideo, type VideoSettings, viewsOf } from './video.js'

  const ENDS = [0, 1] as const

  let view = $state.raw<ViewState>({})
  /** The settings the user chose, kept when the webview reloads. */
  let settings = $state.raw<VideoSettings>({
    ...DEFAULTS,
    ...bridge.state<{ settings?: Partial<VideoSettings> }>({}).settings,
  })
  $effect(() => bridge.save({ settings }))
  let progress = $state.raw<VideoProgress | null>(null)
  let status = $state<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  /** Where the last video was written. */
  let saved = $state('')
  /** The results the time range came from, and whether the user has edited it since. */
  let seeded: string | undefined
  let touched = false
  /** The case's rows, where it saves its diagram blocks, and its results' samples. */
  let snapshot: Snapshot | undefined
  let presentation: Record<string, Positions> = {}
  /** Called as samples arrive, or an ask for them brings none. */
  let arrived = () => {}
  const samples = new Samples({
    request: (input, signal) => bridge.request('samples', input, signal),
    changed: () => arrived(),
    report: (reason) => bridge.report(reason),
  })
  let stop: AbortController | undefined
  /** Whether the user cancelled the running export. */
  let cancelled = false
  const owner = new CanvasGpu()
  const id = $props.id()

  const busy = $derived(status === 'running')
  const range = $derived(view.results?.domain)
  const views = $derived(viewsOf(view))
  const ready = $derived(exportable(settings, view))
  const percent = $derived(
    progress ? Math.floor((100 * progress.completedFrames) / Math.max(1, progress.totalFrames)) : 0,
  )
  const duration = $derived((settings.timeRange[1] - settings.timeRange[0]) / settings.rate)

  const change = (next: Partial<VideoSettings>) => (settings = { ...settings, ...next })

  function toggle(shown: VideoView, on: boolean): void {
    change({
      views: on ? [...settings.views, shown] : settings.views.filter((item) => item !== shown),
    })
  }

  /** Set one end of the time range. */
  function bound(end: 0 | 1, value: number): void {
    touched = true
    change({
      timeRange: end === 0 ? [value, settings.timeRange[1]] : [settings.timeRange[0], value],
    })
  }

  function useRecordedRange(): void {
    touched = false
    if (range) change({ timeRange: [range[0], range[1]] })
  }

  /** Export to a file the user picks, written as frames are encoded. */
  async function start(): Promise<void> {
    if (busy || !ready || !view.summary) return
    const chosen = settings
    const state = view
    const control = (stop = new AbortController())
    const { signal } = control
    status = 'running'
    cancelled = false
    progress = null
    bridge.send({ kind: 'busy', busy: true })
    let file: number | null = null
    try {
      const name = view.summary.name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')
      file = await bridge.request(
        'videoOpen',
        { name: `${name}.${chosen.format}`, format: chosen.format },
        signal,
      )
      if (file === null) {
        status = 'idle'
        return
      }
      const cameras = await bridge.request('videoData', { views: chosen.views }, signal)
      const needs = exportNeeds(state, chosen.views)
      const committed = snapshot
      if (!committed || !current(committed, state))
        throw new Error('The export recording changed while its samples were loading.')
      // Every sample over the time range, before the first frame is drawn.
      samples.want(state.results, needs, chosen.timeRange)
      if (needs.length)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          arrived = () => {
            if (samples.stuck) reject(new Error('The samples to export could not be read.'))
            else if (samples.holds(chosen.timeRange)) resolve()
            else return
            signal.removeEventListener('abort', abort)
          }
          signal.addEventListener('abort', abort, { once: true })
          arrived()
        })
      const rows = committed.data
      const gpu = await owner.get()
      signal.throwIfAborted()
      // Each export follows the device it draws on, which an earlier export may have created.
      const lost = () => control.abort(new Error('WebGPU device lost.'))
      if (gpu.signal.aborted) lost()
      gpu.signal.addEventListener('abort', lost, { once: true, signal })
      const handle = file
      const output = new WritableStream<VideoWrite>({
        write: ({ position, bytes }) =>
          bridge.request('videoWrite', { file: handle, position, bytes }),
      })
      await exportVideo(
        gpu,
        chosen,
        {
          state,
          rows,
          samples: samples.data(rows),
          covers: (from, field, window) => samples.covers(from, field, window),
          presentation,
          cameras,
        },
        output,
        signal,
        (made) => (progress = made),
      )
      saved = (await bridge.request('videoClose', { file })) ?? ''
      file = null
      status = 'done'
    } catch (reason) {
      status = cancelled ? 'cancelled' : 'idle'
      // Report why the export was aborted, not the abort error it caused.
      if (!cancelled)
        bridge.report(signal.aborted && signal.reason instanceof Error ? signal.reason : reason)
    } finally {
      arrived = () => {}
      // The samples served this export alone.
      samples.clear()
      if (file !== null) await bridge.request('videoClose', { file, abort: true }).catch(() => {})
      bridge.send({ kind: 'busy', busy: false })
    }
  }

  onMount(() => {
    const stops = [
      bridge.on((message) => {
        if (message.kind !== 'state') return
        view = merged(view, message.state)
        appearance(view.settings)
        const { results } = view
        // The time range follows the results until the user edits it.
        if (
          results &&
          results.domain[1] > results.domain[0] &&
          (results.id !== seeded || !touched) &&
          !busy
        ) {
          if (results.id !== seeded) touched = false
          seeded = results.id
          const [start, end] = settings.timeRange
          if (start !== results.domain[0] || end !== results.domain[1])
            change({ timeRange: [results.domain[0], results.domain[1]] })
        }
        const offered = viewsOf(view).map(({ value }) => value)
        if (view.summary && settings.views.some((shown) => !offered.includes(shown)))
          change({ views: settings.views.filter((shown) => offered.includes(shown)) })
      }),
      receiveRows((next) => {
        snapshot = next
        if (next.rows.presentation) presentation = next.rows.presentation
      }),
    ]
    bridge.send({ kind: 'ready' })
    return () => {
      stop?.abort()
      for (const off of stops) off()
      owner.dispose()
    }
  })
</script>

<form
  class="export c-settings"
  data-testid="video-export"
  onsubmit={(event) => {
    event.preventDefault()
    void start()
  }}
>
  <fieldset disabled={busy} class="export__fields">
    <Section label="Views">
      {#each views as shown (shown.value)}
        <Switch
          label={shown.label}
          bind:checked={() => settings.views.includes(shown.value), (on) => toggle(shown.value, on)}
        />
      {/each}
      <Select
        label="Arrangement"
        disabled={settings.views.length < 2}
        options={[
          { value: 'column', label: 'Stacked' },
          { value: 'row', label: 'Side by side' },
        ]}
        bind:value={
          () => settings.layout,
          (layout) => {
            if (layout) change({ layout })
          }
        }
      />
    </Section>
    <Section label="Time">
      {#each ENDS as end (end)}
        <div class="c-row c-setting-row">
          <label class="c-row__label" for="{id}-{end}">{end ? 'End' : 'Start'} (s)</label>
          <input
            id="{id}-{end}"
            class="c-input"
            type="number"
            step="any"
            min={range?.[0]}
            max={range?.[1]}
            value={settings.timeRange[end]}
            oninput={(event) => bound(end, event.currentTarget.valueAsNumber)}
          />
        </div>
      {/each}
      <button
        type="button"
        class="c-btn c-btn--sm export__range"
        disabled={!range}
        onclick={useRecordedRange}
      >
        Use recorded range
      </button>
      <Select
        label="Playback speed"
        options={[0.25, 0.5, 1, 2, 4].map((value) => ({ value, label: value + 'x' }))}
        bind:value={
          () => settings.rate,
          (rate) => {
            if (rate) change({ rate })
          }
        }
      />
      {#if Number.isFinite(duration) && duration > 0}
        <p class="c-note">Output duration: {duration.toFixed(2)} s.</p>
      {/if}
    </Section>
    <Section label="Output">
      <Select
        label="Format"
        options={[
          { value: 'mp4', label: 'MP4' },
          { value: 'webm', label: 'WebM' },
        ]}
        data-testid="video-format"
        bind:value={
          () => settings.format,
          (format) => {
            if (format) change({ format })
          }
        }
      />
      <Select
        label="Resolution"
        options={[
          { value: 720, label: '720p' },
          { value: 1080, label: '1080p' },
          { value: 2160, label: '4K' },
        ]}
        data-testid="video-resolution"
        bind:value={
          () => settings.height,
          (height) => {
            if (height) change({ height, width: (height * 16) / 9 })
          }
        }
      />
      <Select
        label="Frame rate"
        options={[24, 30, 60].map((value) => ({ value, label: value + ' fps' }))}
        bind:value={
          () => settings.frameRate,
          (frameRate) => {
            if (frameRate) change({ frameRate })
          }
        }
      />
      <Select
        label="Quality"
        options={[
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'very-high', label: 'Very high' },
        ]}
        bind:value={
          () => settings.quality,
          (quality) => {
            if (quality) change({ quality })
          }
        }
      />
    </Section>
  </fieldset>
  <div class="export__footer">
    <div class="export__actions">
      <button
        class="c-btn c-btn--primary"
        type="submit"
        disabled={busy || !ready}
        data-testid="video-start"
      >
        Export video
      </button>
      {#if busy}
        <button
          class="c-btn"
          type="button"
          onclick={() => {
            cancelled = true
            stop?.abort()
          }}
        >
          Cancel
        </button>
      {/if}
    </div>
    <div class="export__status">
      {#if busy}
        <progress max="100" value={percent} aria-label="Video export progress"></progress>
        <p class="c-note" role="status">
          {progress?.phase === 'finalizing'
            ? 'Finalizing video...'
            : progress
              ? 'Exporting video: ' + percent + '%'
              : 'Preparing video...'}
        </p>
      {:else if status === 'done'}
        <p class="c-note" role="status" data-testid="video-done">Exported {saved}</p>
      {:else if status === 'cancelled'}
        <p class="c-note" role="status">Export cancelled.</p>
      {/if}
    </div>
  </div>
</form>

<style>
  .export {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    overflow-y: auto;
  }

  .export__fields {
    min-inline-size: 0;
  }

  .export :global(.c-input) {
    inline-size: 8rem;
    max-inline-size: 100%;
  }

  .export__fields:disabled {
    opacity: 0.7;
  }

  .export__range {
    margin-inline-start: var(--spacing-xs);
  }

  .export__footer {
    margin-block-start: auto;
    padding: var(--spacing-md) var(--spacing-sm);
    border-block-start: 1px solid var(--color-border);
  }

  .export__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
  }

  .export__status {
    min-block-size: 4rem;
    padding-block-start: var(--spacing-sm);
    overflow-wrap: anywhere;
  }

  .export__status .c-note {
    margin-inline: 0;
  }

  progress {
    inline-size: 100%;
    block-size: 0.4rem;
    accent-color: var(--color-primary-text);
  }
</style>
