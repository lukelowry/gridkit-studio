import { describe, expect, it, vi } from 'vitest'

import type { Results, Summary, ViewState } from '../../shared/messages.js'
import { DEFAULTS, exportable, videoTimes } from './video.js'

// What a video shows and whether it can start ask nothing of the extension.
vi.mock('../bridge.js', () => ({ bridge: {} }))

/** Results that hold `domain`, and will cover `span` once their run ends. */
const results = (domain: [number, number], span?: [number, number]) =>
  ({ id: 'r', domain, ...(span && { span }), frames: 10, outputs: [] }) as unknown as Results
const summary = { schema: { types: {} }, counts: {} } as unknown as Summary

describe('a video', () => {
  it('shows the times the Monitor shows, within those its results hold', () => {
    // The whole run, as the Monitor shows it until a window is chosen.
    expect(videoTimes({ results: results([0, 2]) })).toEqual([0, 2])
    expect(videoTimes({ results: results([0, 2]), window: [0.5, 1.5] })).toEqual([0.5, 1.5])
    // A run still writing shows its whole span, of which the video shows what it holds so far.
    expect(videoTimes({ results: results([0, 1], [0, 4]) })).toEqual([0, 1])
    expect(videoTimes({ results: results([0, 2]), window: [1.5, 3] })).toEqual([1.5, 2])
    // Nothing to show: no results, results of one moment, or a window past them.
    expect(videoTimes({})).toBeUndefined()
    expect(videoTimes({ results: results([1, 1]) })).toBeUndefined()
    expect(videoTimes({ results: results([0, 2]), window: [3, 4] })).toBeUndefined()
  })

  it('exports once it has times, a view, an even size and a speed', () => {
    const state: ViewState = { summary, results: results([0, 2]) }
    const job = { ...DEFAULTS, timeRange: [0, 2] as [number, number], rate: 1 }
    expect(exportable(job, state)).toBe(true)
    expect(exportable(undefined, state)).toBe(false)
    expect(exportable({ ...job, views: [] }, state)).toBe(false)
    expect(exportable({ ...job, width: 1279 }, state)).toBe(false)
    expect(exportable({ ...job, rate: 0 }, state)).toBe(false)
    // The Monitor's part needs a plot the results hold.
    expect(exportable({ ...job, views: ['monitor'] }, state)).toBe(false)
  })
})
