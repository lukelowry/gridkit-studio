import { type Camera, type Placed, Shot, type Video, View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Framing, VideoView, ViewState } from '../../shared/messages.js'
import { isRecorded } from '../../shared/plots.js'
import { monitorWindow } from '../monitor/plot.js'

export interface VideoSettings {
  readonly views: readonly VideoView[]
  readonly layout: 'column' | 'row'
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly quality: 'medium' | 'high' | 'very-high'
}
/** The camera that fits what `framing`'s canvas showed into a `width` by `height` picture. Zoom is
 *  log₂ of pixels per unit, so scaling adds to it. */
export function framed({ camera, size }: Framing, [width, height]: readonly [number, number]) {
  if (!('zoom' in camera)) return camera
  const scale = Math.min(width / size[0], height / size[1])
  return { ...camera, zoom: camera.zoom + Math.log2(scale) } satisfies Camera
}

export interface VideoJob extends VideoSettings {
  readonly timeRange: TimeRange
  readonly rate: number
}
export interface VideoProgress {
  readonly frames: number
  readonly total: number
  readonly time: number
}
export const DEFAULTS: VideoSettings = {
  views: ['network'],
  layout: 'column',
  width: 1920,
  height: 1080,
  frameRate: 30,
  quality: 'high',
}

export function viewsOf({ summary }: ViewState): Array<{ value: VideoView; label: string }> {
  if (!summary) return []
  const drawing = summary.definition.drawing
  return [
    ...(drawing.vertices.some((vertex) => summary.counts[vertex.table])
      ? [{ value: 'network' as const, label: 'Network' }]
      : []),
    { value: 'monitor', label: 'Monitor' },
  ]
}
export function videoTimes(state: ViewState): TimeRange | undefined {
  const domain = state.results?.domain
  if (!domain || domain[1] <= domain[0]) return undefined
  const timeWindow = monitorWindow(state.results, state.window)
  const range: TimeRange = [Math.max(domain[0], timeWindow[0]), Math.min(domain[1], timeWindow[1])]
  return range[0] < range[1] ? range : undefined
}
/** At least one encoder block (latkit rounds to whole blocks), and a positive rate over a span. */
function valid(job: VideoJob): boolean {
  return (
    Number.isFinite(job.width) &&
    job.width >= 4 &&
    Number.isFinite(job.height) &&
    job.height >= 2 &&
    Number.isFinite(job.frameRate) &&
    job.frameRate > 0 &&
    ['medium', 'high', 'very-high'].includes(job.quality) &&
    Number.isFinite(job.rate) &&
    job.rate > 0 &&
    job.timeRange.every(Number.isFinite) &&
    job.timeRange[1] > job.timeRange[0]
  )
}

export function exportable(job: VideoJob | undefined, state: ViewState): job is VideoJob {
  return (
    !!job &&
    !!state.summary &&
    !!job.views.length &&
    (!job.views.includes('monitor') ||
      !!state.plots?.some((plot) => isRecorded(state.results, plot))) &&
    valid(job)
  )
}

/** Encodes `job` from the `placed` views to `output`; `job` must pass `exportable`. */
export async function exportVideo(
  job: VideoJob,
  placed: readonly Placed[],
  output: WritableStream<Uint8Array>,
  prepare: (at: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  progress: (value: VideoProgress) => void,
): Promise<void> {
  const [from, to] = job.timeRange
  // One frame per 1 / frameRate seconds of video, plus one at the end so the video ends on it.
  const total = Math.ceil(((to - from) / job.rate) * job.frameRate) + 1
  if (!Number.isSafeInteger(total)) throw new Error('The video contains too many frames.')
  const bitrate =
    job.width *
    job.height *
    job.frameRate *
    { medium: 0.08, high: 0.15, 'very-high': 0.25 }[job.quality]
  const views = placed.map((each) => (each instanceof View ? each : each.view))
  const shot = new Shot([job.width, job.height], { views: placed, capture: 'now' })
  let video: Video | undefined
  try {
    signal.throwIfAborted()
    video = shot.video({ fps: job.frameRate, bitrate, output, signal })
    for (let frame = 0; frame < total; frame++) {
      signal.throwIfAborted()
      const at = Math.min(to, from + (frame / job.frameRate) * job.rate)
      await prepare(at, signal)
      signal.throwIfAborted()
      for (const view of views) view.at = at
      await video.frame()
      progress({ frames: frame + 1, total, time: at })
    }
    await video.finish()
  } catch (error) {
    if (video) await video.abort(error).catch(() => {})
    else await output.abort(error).catch(() => {})
    throw error
  }
}
