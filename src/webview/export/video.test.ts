import { describe, expect, it, vi } from 'vitest'

import type { Results, Summary, ViewState } from '../../shared/messages.js'
import { exportDefaults } from '../../shared/settings.js'
import { type ExportJob, framed, framesOf, problemOf, videoTimes } from './video.js'

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

  it('exports once it has a view, a span that ends after it starts, and a speed', () => {
    const state: ViewState = { summary, results: results([0, 2]) }
    const job: ExportJob = {
      format: 'video',
      views: ['network'],
      layout: 'column',
      timeRange: [0, 2],
      rate: 1,
      settings: exportDefaults,
    }
    expect(problemOf(job, state)).toBeUndefined()
    expect(problemOf({ ...job, views: [] }, state)).toMatch(/view/)
    expect(problemOf({ ...job, timeRange: [2, 2] }, state)).toMatch(/span/)
    expect(problemOf({ ...job, rate: 0 }, state)).toMatch(/speed/)
    // An image shows one instant, so it needs no span.
    expect(problemOf({ ...job, format: 'image', timeRange: [1, 1] }, state)).toBeUndefined()
    // The Monitor exports only a monitor the results record.
    const shown: ViewState = { ...state, shown: [{ table: 'Bus', field: 'Vm' }] }
    expect(problemOf({ ...job, views: ['monitor'] }, shown)).toMatch(/no recorded signal/)
    const recorded = { ...results([0, 2]), outputs: [{ table: 'Bus', field: 'Vm', ids: [1] }] }
    expect(
      problemOf({ ...job, views: ['monitor'] }, { ...shown, results: recorded }),
    ).toBeUndefined()
  })

  it('has a frame per frame interval at its speed, and one more to end on its last time', () => {
    const job: ExportJob = {
      format: 'video',
      views: ['network'],
      layout: 'column',
      timeRange: [0, 2],
      rate: 0.5,
      settings: { ...exportDefaults, 'export.frameRate': 30 },
    }
    // Two simulated seconds at half speed take four seconds of video.
    expect(framesOf(job)).toBe(4 * 30 + 1)
  })
})
