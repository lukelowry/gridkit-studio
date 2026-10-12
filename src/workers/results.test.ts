import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Data } from '@latkit/model'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { Results, ResultsApi, SamplesInput } from '../shared/messages.js'
import { bundle, start } from './rig.js'

let script: string
beforeAll(async () => {
  script = await bundle('results', 'results-worker')
})

type Rig = Awaited<ReturnType<typeof start<ResultsApi>>>

/** A case of one bus, `one`, and its source. */
const ONE = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'

/** The case `name`, of one bus, at its first revision, with its source. */
const caseOf = (name: string) => ({
  uri: `file:///${name}.case.json`,
  version: 1,
  fingerprint: '',
  text: ONE,
})

/** Opens the results file at `path` for `revision` under an id of its own, as the extension does. */
const open = (
  rig: Rig,
  revision: ReturnType<typeof caseOf>,
  path: string,
  signal?: AbortSignal,
): Promise<Results> => rig.call('open', { ...revision, results: randomUUID(), path }, signal)

/** `results` as the worker last told of them: each event's progress, and layout when it changed,
 *  over what the open answered. */
function told(rig: Rig, results: Results): Results {
  let now = results
  for (const event of rig.events)
    if (event.kind === 'results' && event.results === results.id)
      now = { ...now, ...event.layout, ...event.progress }
  return now
}

/** `results` as they are once read to the end, as the worker last told of them. */
async function read(rig: Rig, results: Results): Promise<Results> {
  if (!results.growing) return results
  return vi.waitFor(
    () => {
      const now = told(rig, results)
      if (now.growing) throw new Error(`${results.name} is still being read.`)
      return now
    },
    { timeout: 5000 },
  )
}

/** A CSV file of `frames` frames of bus `one`'s voltage, each `value(i)` at time `i`. */
async function waveform(path: string, frames: number, value = (i: number) => String(i % 3)) {
  await writeFile(
    path,
    'time,Bus_one_Vm\n' + Array.from({ length: frames }, (_, i) => `${i},${value(i)}\n`).join(''),
  )
}

/** Everything a view asking for `field` over all of `results` is sent, asking again for what it
 *  lacks until nothing more comes, as a view does. */
async function everything(rig: Rig, results: Results, field: SamplesInput['field']) {
  const held: Record<number, number> = {}
  const sent: Data.SampleBatch[] = []
  for (;;) {
    const batches = await rig.call('samples', {
      results: results.id,
      field,
      window: results.domain,
      held,
      bytes: 8 << 20,
    })
    if (!batches.length) return sent
    for (const batch of batches) {
      const k = Math.floor(batch.firstFrame / results.chunk)
      held[k] = batch.firstFrame + batch.coordinates.length - k * results.chunk
      sent.push(batch)
    }
  }
}

describe('the results worker', () => {
  it('sends a view every frame of a file once and in order, a chunk at a time', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const path = join(rig.scratch, 'many.csv')
      const frames = 600_000
      await waveform(path, frames)
      const results = await read(rig, await open(rig, caseOf('chunks'), path))
      expect(results.domains).toEqual({ Bus: { Vm: [0, 2] } })
      expect(results.frames).toBeGreaterThan(results.chunk)
      const sent = await everything(rig, results, { from: 'Bus', select: ['Vm'] })
      // Each batch is part of one chunk, and the chunks tile every frame in order.
      for (const batch of sent)
        expect(Math.floor((batch.firstFrame + batch.coordinates.length - 1) / results.chunk)).toBe(
          Math.floor(batch.firstFrame / results.chunk),
        )
      const times = sent
        .sort((a, b) => a.firstFrame - b.firstFrame)
        .flatMap((batch) => Array.from(batch.coordinates))
      expect(times).toHaveLength(frames)
      expect(times.every((time, i) => time === i)).toBe(true)
    } finally {
      await rig.stop()
    }
  })

  it('answers once the first frames are read, and reads on to the end', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const path = join(rig.scratch, 'long.csv')
      const frames = 700_000
      await waveform(path, frames, () => '1')
      const opened = await open(rig, caseOf('long'), path)
      // A file of several segments: the first is read before the request answers, the rest after.
      expect(opened.growing).toBe(true)
      expect(opened.frames).toBeGreaterThan(0)
      expect(opened.frames).toBeLessThan(frames)
      const results = await read(rig, opened)
      expect(results).toMatchObject({ growing: false, frames, domain: [0, frames - 1] })
      expect(results.error).toBeUndefined()
    } finally {
      await rig.stop()
    }
  })

  it('says why a file stops reading partway, and keeps what it read', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      // Its last row, a segment past its first, lacks the voltage.
      const path = join(rig.scratch, 'broken-late.csv')
      const frames = 700_000
      await writeFile(
        path,
        'time,Bus_one_Vm\n' +
          Array.from({ length: frames }, (_, i) => `${i},1\n`).join('') +
          `${frames}\n`,
      )
      const results = await read(rig, await open(rig, caseOf('late'), path))
      expect(results.growing).toBe(false)
      expect(results.error).toMatch(/does not match its header/)
      expect(results.frames).toBeGreaterThan(0)
    } finally {
      await rig.stop()
    }
  })

  it('reads a case by its fingerprint while results of it are held, and asks for it once none are', async () => {
    // Nothing rests: what nothing holds is let go of at once.
    const rig = await start<ResultsApi>(script, { options: { cacheBytes: 0 } })
    try {
      const path = join(rig.scratch, 'small.csv')
      await waveform(path, 3)
      const { text: _, ...unread } = caseOf('known')
      await expect(
        rig.call('open', { ...unread, results: randomUUID(), path }),
      ).rejects.toMatchObject({ code: 'needs-source' })
      const first = await open(rig, caseOf('known'), path)
      // The results carry the case's own fingerprint, which reads it again without its source.
      const lean = { ...unread, version: 2, fingerprint: first.fingerprint }
      const again = await rig.call('open', { ...lean, results: randomUUID(), path })
      expect(again.fingerprint).toBe(first.fingerprint)
      // The same file of the same case, read now: held again, and read once.
      expect(await rig.call('stats', {})).toMatchObject({ results: 2, files: 1, cases: 1 })
      // Once the last results that read it close, so does the case.
      for (const { id } of [first, again]) await rig.call('close', { results: id })
      expect(await rig.call('stats', {})).toMatchObject({ files: 0, cases: 0 })
      await expect(
        rig.call('open', { ...lean, results: randomUUID(), path }),
      ).rejects.toMatchObject({ code: 'needs-source' })
    } finally {
      await rig.stop()
    }
  })

  it('keeps nothing of an open let go of before it answers', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const large = join(rig.scratch, 'large.csv')
      await waveform(large, 700_000)
      const small = join(rig.scratch, 'small.csv')
      await waveform(small, 3)
      const controller = new AbortController()
      const cancelled = open(rig, caseOf('cancelled'), large, controller.signal)
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      // The worker takes requests in order: once a later open answers, the cancelled one has
      // settled, and the later is the only file read.
      const kept = await read(rig, await open(rig, caseOf('cancelled'), small))
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, resting: 0 })
      expect(
        rig.events.every((event) => event.kind !== 'results' || event.results === kept.id),
      ).toBe(true)
    } finally {
      await rig.stop()
    }
  })

  it('reads a results file where it is, says what it holds, and never changes it', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const path = join(rig.scratch, 'original.csv')
      const source = 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n'
      await writeFile(path, source)
      const results = await read(rig, await open(rig, caseOf('in-place'), path))
      expect(results).toMatchObject({ growing: false, path, frames: 3 })
      // The rows the file holds, as the case numbers them: here the one bus.
      expect(results.outputs).toMatchObject([
        { from: 'Bus', select: ['Vm'], rows: { kind: 'range', offset: 0, count: 1 } },
      ])
      expect(results.domains).toEqual({ Bus: { Vm: [0.8, 1] } })
      // What the views read of the case it was read against, and not its issues, which are the
      // case worker's to say.
      expect(await rig.call('describe', { results: results.id })).toMatchObject({
        fingerprint: results.fingerprint,
        validation: 'pending',
      })
      const exported = join(rig.scratch, 'exported.csv')
      await rig.call('export', { results: results.id, path: exported })
      expect(await readFile(exported, 'utf8')).toContain('0.8')
      await rig.call('close', { results: results.id })
      await expect(
        rig.call('export', { results: results.id, path: exported }),
      ).rejects.toMatchObject({ code: 'results-closed' })
      // Closing lets go of the results; the file is the user's, and stays as it was.
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally {
      await rig.stop()
    }
  })

  it('reads what it read of a file written again since, and the file anew when opened again', async () => {
    // Nothing kept but the store: every read of the results is of the store.
    const rig = await start<ResultsApi>(script, { options: { cacheBytes: 0 } })
    try {
      const path = join(rig.scratch, 'rewritten.csv')
      await waveform(path, 3, () => '1')
      const results = await read(rig, await open(rig, caseOf('rewritten'), path))
      // Another run writes the same file, as long, with other values, a moment later.
      await waveform(path, 3, () => '9')
      const later = new Date(Date.now() + 2000)
      await utimes(path, later, later)
      const values = async (of: Results) =>
        (await everything(rig, of, { from: 'Bus', select: ['Vm'] })).flatMap((batch) =>
          Array.from(batch.columns.Vm!.values),
        )
      expect(await values(results)).toEqual([1, 1, 1])
      expect(await values(await read(rig, await open(rig, caseOf('rewritten'), path)))).toEqual([
        9, 9, 9,
      ])
    } finally {
      await rig.stop()
    }
  })

  it('holds one file by several ids, as an export holds what a view shows, and rests it once none do', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const path = join(rig.scratch, 'shared.csv')
      await waveform(path, 3)
      const shown = await read(rig, await open(rig, caseOf('shared'), path))
      const exported = await rig.call('share', { results: shown.id, as: randomUUID() })
      expect(exported).toMatchObject({ frames: 3, path })
      // The view lets go; the export reads on.
      await rig.call('close', { results: shown.id })
      expect(await everything(rig, exported, { from: 'Bus', select: ['Vm'] })).not.toEqual([])
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, resting: 0 })
      await rig.call('close', { results: exported.id })
      expect(await rig.call('stats', {})).toMatchObject({ results: 0, files: 0, resting: 1 })
      // Opened again, it is the file at rest, read nothing again, and its case with it: no source
      // is asked for.
      const { text: _, ...lean } = { ...caseOf('shared'), fingerprint: shown.fingerprint }
      const again = await rig.call('open', { ...lean, results: randomUUID(), path })
      expect(again).toMatchObject({ growing: false, frames: 3 })
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, resting: 0 })
      // A budget too small for it lets what rests go.
      await rig.call('close', { results: again.id })
      await rig.call('configure', { cacheBytes: 0 })
      expect(await rig.call('stats', {})).toMatchObject({ resting: 0, cases: 0, cacheBytes: 0 })
    } finally {
      await rig.stop()
    }
  })

  it('reads the same file again in a fresh worker, as a reload does', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-reload-'))
    const csv = join(folder, 'results.csv')
    await writeFile(csv, 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n')
    let rig = await start<ResultsApi>(script, { folder })
    try {
      const first = await read(rig, await open(rig, caseOf('reloaded'), csv))
      const exported = join(folder, 'exported.csv')
      await rig.call('export', { results: first.id, path: exported })
      const measured = await readFile(exported, 'utf8')
      await rig.stop()
      // A saved session names the file, so its store is kept, and read alone, without the CSV.
      rig = await start<ResultsApi>(script, { folder, options: { saved: [csv] } })
      const again = await open(rig, caseOf('reloaded'), csv)
      expect(again.growing).toBe(false)
      expect(again).toMatchObject({
        frames: first.frames,
        domain: first.domain,
        domains: first.domains,
        outputs: first.outputs,
        chunk: first.chunk,
      })
      await rig.call('export', { results: again.id, path: exported })
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      expect(await rig.call('step', { results: again.id, at: 0, direction: 1 })).toBe(1)
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('holds what the extension holds open, of however many cases, and nothing once it closes them', async () => {
    const rig = await start<ResultsApi>(script)
    try {
      const path = join(rig.scratch, 'shared.csv')
      await waveform(path, 3)
      const opened = await Promise.all(
        Array.from({ length: 20 }, async (_, n) =>
          read(rig, await open(rig, caseOf(`case-${n}`), path)),
        ),
      )
      expect(await rig.call('stats', {})).toMatchObject({ results: 20, files: 20, cases: 20 })
      // Each read through, so nothing stops as it is let go of.
      for (const { id } of opened) await rig.call('close', { results: id })
      // What nothing holds rests, under the budget, till it is let go of with the budget.
      expect(await rig.call('stats', {})).toMatchObject({ results: 0, files: 0, resting: 20 })
      await rig.call('configure', { cacheBytes: 0 })
      expect(await rig.call('stats', {})).toMatchObject({
        results: 0,
        resting: 0,
        cases: 0,
        runs: 0,
        cacheBytes: 0,
      })
      // Closing what it never held, or holds no more, is no failure.
      await rig.call('close', { results: opened[0]!.id })
    } finally {
      await rig.stop()
    }
  })

  it('sends a view only the frames it lacks, and nothing of results closed', async () => {
    const rig = await start<ResultsApi>(script)
    const { scratch, call, stop } = rig
    try {
      const text = await readFile('cases/TwoArea.case.json', 'utf8')
      const revision = { uri: 'file:///test.case.json', version: 1, fingerprint: '', text }
      // 700,000 frames of one bus's voltage: a few chunks of results.
      const path = join(scratch, 'waveform.csv')
      const name = JSON.parse(text).buses[0].name
      const count = 700_000
      await writeFile(
        path,
        `time,Bus_${name}_Vm\n` +
          Array.from({ length: count }, (_, i) => `${i / 100},${1 + (i % 200) / 1000}\n`).join(''),
      )
      const results = await read(rig, await open(rig, revision, path))
      expect(results).toMatchObject({ growing: false, frames: count })
      expect(results.domains).toEqual({ Bus: { Vm: [1, 1.199] } })
      // Results whose first frames cannot be read fail to open, and leave nothing held.
      const broken = join(scratch, 'broken.csv')
      await writeFile(broken, `time,Bus_${name}_Vm\n0,1\n0.01\n`)
      await expect(open(rig, revision, broken)).rejects.toThrow(/does not match its header/)
      expect(await call('stats', {})).toMatchObject({ results: 1, files: 1, resting: 0 })
      const field = results.outputs[0]!
      const ask = (held: Record<number, number>) =>
        call('samples', {
          results: results.id,
          field,
          window: [results.domain[1], results.domain[1]],
          held,
          bytes: 8 << 20,
        })
      // The last moment needs the last chunk, and a view holding it is sent nothing.
      const last = Math.floor((count - 1) / results.chunk)
      const sent = await ask({})
      expect(sent.map(({ firstFrame }) => firstFrame)).toEqual([last * results.chunk])
      expect(await ask({ [last]: count - last * results.chunk })).toEqual([])
      expect((await call('describe', { results: results.id })).version).toBe(revision.version)
      await call('close', { results: results.id })
      expect(await call('stats', {})).toMatchObject({ results: 0, files: 0 })
      await expect(ask({})).rejects.toMatchObject({ code: 'results-closed' })
    } finally {
      await stop()
    }
  })
})
