import { describe, expect, it, vi } from 'vitest'

import type { Results, Summary, ViewState } from '../../shared/messages.js'
import { DEFAULTS, exportable, framed, videoTimes } from './video.js'

// These helpers never call the extension.
vi.mock('../bridge.js', () => ({ bridge: {} }))

/** Results recorded over `domain`, with `span` once the run ends. */
const results = (domain: [number, number], span?: [number, number]) =>
  ({ id: 'r', domain, ...(span && { span }), frames: 10, outputs: [] }) as unknown as Results
const summary = { schema: { types: {} }, counts: {} } as unknown as Summary

describe('a video', () => {
  it("covers the Monitor's window, clipped to the recorded results", () => {
    expect(videoTimes({ results: results([0, 2]) })).toEqual([0, 2])
    expect(videoTimes({ results: results([0, 2]), window: [0.5, 1.5] })).toEqual([0.5, 1.5])
    // A running simulation shows its whole span; the video covers only what is recorded.
    expect(videoTimes({ results: results([0, 1], [0, 4]) })).toEqual([0, 1])
    expect(videoTimes({ results: results([0, 2]), window: [1.5, 3] })).toEqual([1.5, 2])
    // Nothing to show: no results, a single instant, or a window past the results.
    expect(videoTimes({})).toBeUndefined()
    expect(videoTimes({ results: results([1, 1]) })).toBeUndefined()
    expect(videoTimes({ results: results([0, 2]), window: [3, 4] })).toBeUndefined()
  })

  it('frames what the canvas showed, its place, tilt and turn kept, at the picture size', () => {
    const camera = { center: [-97, 31] as [number, number], zoom: 5, pitch: 60, bearing: 30 }
    // A picture twice the canvas each way shows the same at one zoom level more.
    expect(framed({ camera, size: [800, 450] }, [1600, 900])).toEqual({ ...camera, zoom: 6 })
    // With another aspect ratio, the narrower side decides, so everything still fits.
    expect(framed({ camera, size: [800, 800] }, [1600, 900])).toEqual({
      ...camera,
      zoom: 5 + Math.log2(900 / 800),
    })
  })

  it('exports once it has times, a view, a size and a speed', () => {
    const state: ViewState = { summary, results: results([0, 2]) }
    const job = { ...DEFAULTS, timeRange: [0, 2] as [number, number], rate: 1 }
    expect(exportable(job, state)).toBe(true)
    expect(exportable(undefined, state)).toBe(false)
    expect(exportable({ ...job, views: [] }, state)).toBe(false)
    // latkit rounds sizes to encoder blocks, so it refuses only a size under one block.
    expect(exportable({ ...job, width: 1279 }, state)).toBe(true)
    expect(exportable({ ...job, width: 2 }, state)).toBe(false)
    expect(exportable({ ...job, rate: 0 }, state)).toBe(false)
    const plotted: ViewState = { ...state, plots: [{ table: 'Bus', field: 'Vm' }] }
    expect(exportable({ ...job, views: ['monitor'] }, plotted)).toBe(false)
    const recorded = { ...results([0, 2]), outputs: [{ table: 'Bus', field: 'Vm', ids: [1] }] }
    expect(exportable({ ...job, views: ['monitor'] }, { ...plotted, results: recorded })).toBe(true)
  })
})
