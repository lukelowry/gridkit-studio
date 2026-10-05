import { setImmediate as yieldTurn } from 'node:timers/promises'

import { read, sampleAt } from '@latkit/model'

import type { SignalOptions, SignalResult } from '../shared/analysis.js'
import { analysisSelection, snapshot } from './analysis.js'
import type { Results } from './results.js'

type Sample = SignalResult['series'][number]['samples'][number]
type Bucket = { first: Sample; last: Sample; min?: Sample; max?: Sample; gap?: Sample }

/** Exact pages or an extrema-preserving envelope; every observation keeps its original frame. */
export async function querySignals(
  run: Results,
  input: SignalOptions,
  signal: AbortSignal,
): Promise<SignalResult> {
  const captured = snapshot(run)
  const { from, field, selected, recorded, table, definition, window } = analysisSelection(
    run,
    input,
    captured,
  )
  if (!input.ids.length) throw new Error('Choose at least one signal element.')
  const representation = input.representation
  const size = representation.kind === 'exact' ? representation.maxSamples : representation.buckets
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error('Choose a positive sample or bucket count.')
  const offset = representation.kind === 'exact' ? (representation.offset ?? 0) : 0
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Use a nonnegative sample offset.')
  const state = new Map(
    Array.from(selected, (row) => [
      row,
      { count: 0, samples: [] as Sample[], buckets: new Map<number, Bucket>() },
    ]),
  )
  for (let p = 0; p < captured.pages; p++) {
    signal.throwIfAborted()
    const page = run.pages[p]!
    if (page.domain[1] < window[0] || page.domain[0] > window[1]) continue
    await yieldTurn(undefined, { signal })
    for await (const block of read(
      await run.pageData(p, signal),
      {
        kind: 'samples',
        from,
        select: [field],
        rows: { kind: 'indices', index: recorded.index, values: selected },
        window: { kind: 'range', between: window },
      },
      { signal, maxBlockBytes: 256 << 10 },
    )) {
      if (block.kind !== 'samples') continue
      const count = block.rows.kind === 'range' ? block.rows.count : block.rows.values.length
      for (let row = 0; row < count; row++) {
        const physical =
          block.rows.kind === 'range' ? block.rows.offset + row : block.rows.values[row]!
        const into = state.get(physical)!
        for (let f = 0; f < block.coordinates.length; f++) {
          const value = sampleAt(block.columns[field]!, row, f)
          const sample: Sample = {
            time: block.coordinates[f]!,
            frame: block.firstFrame + f,
            value: value !== null && Number.isFinite(value) ? value : null,
          }
          const at = into.count++
          if (representation.kind === 'exact') {
            if (at >= offset && into.samples.length < size) into.samples.push(sample)
          } else {
            const index =
              window[1] === window[0]
                ? 0
                : Math.min(
                    size - 1,
                    Math.floor(((sample.time - window[0]) / (window[1] - window[0])) * size),
                  )
            let bucket = into.buckets.get(index)
            if (!bucket) into.buckets.set(index, (bucket = { first: sample, last: sample }))
            bucket.last = sample
            if (sample.value === null) bucket.gap ??= sample
            else {
              if (!bucket.min || sample.value < bucket.min.value!) bucket.min = sample
              if (!bucket.max || sample.value > bucket.max.value!) bucket.max = sample
            }
          }
        }
      }
    }
    if (
      representation.kind === 'exact' &&
      [...state.values()].every((s) => s.count > offset + size)
    )
      break
  }
  return {
    run: captured.info.id,
    revision: captured.info.revision,
    fingerprint: captured.info.fingerprint,
    snapshot: { pages: captured.pages, frames: captured.info.frames, domain: captured.info.domain },
    from,
    field,
    unit: definition.unit ?? null,
    window,
    representation,
    series: [...state].map(([row, item]) => ({
      id: run.kase.id(table, row),
      samples:
        representation.kind === 'exact'
          ? item.samples
          : [...item.buckets.values()].flatMap((bucket) =>
              [
                ...new Map(
                  [bucket.first, bucket.last, bucket.min, bucket.max, bucket.gap]
                    .filter((v): v is Sample => !!v)
                    .map((v) => [v.frame, v]),
                ).values(),
              ].sort((a, b) => a.frame - b.frame),
            ),
    })),
    nextOffset:
      representation.kind === 'exact' && [...state.values()].some((s) => s.count > offset + size)
        ? offset + size
        : null,
  }
}
