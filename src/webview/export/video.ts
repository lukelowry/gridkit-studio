import { type Placed, Shot, type Video, type View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { VideoView, ViewState } from '../../shared/messages.js'
import { holdsPlot } from '../../shared/plots.js'
import { monitorWindow } from '../monitor/plot.js'

export interface VideoSettings {
  readonly views: readonly VideoView[]
  readonly layout: 'column' | 'row'
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly quality: 'medium' | 'high' | 'very-high'
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
    ...(drawing.blocks.some((block) => summary.counts[block.table])
      ? [{ value: 'diagram' as const, label: 'Diagram' }]
      : []),
    { value: 'monitor', label: 'Monitor' },
  ]
}
export function videoTimes(state: ViewState): TimeRange | undefined {
  const held = state.results?.domain
  if (!held || held[1] <= held[0]) return undefined
  const shown = monitorWindow(state.results, state.window)
  const range: TimeRange = [Math.max(held[0], shown[0]), Math.min(held[1], shown[1])]
  return range[0] < range[1] ? range : undefined
}
export function exportable(job: VideoJob | undefined, state: ViewState): job is VideoJob {
  return (
    !!job &&
    !!state.summary &&
    !!job.views.length &&
    (!job.views.includes('monitor') ||
      !!state.plots?.some((plot) => holdsPlot(state.results, plot))) &&
    Number.isSafeInteger(job.width) &&
    job.width >= 4 &&
    job.width % 4 === 0 &&
    Number.isSafeInteger(job.height) &&
    job.height >= 2 &&
    job.height % 2 === 0 &&
    Number.isFinite(job.frameRate) &&
    job.frameRate > 0 &&
    ['medium', 'high', 'very-high'].includes(job.quality) &&
    Number.isFinite(job.rate) &&
    job.rate > 0 &&
    job.timeRange.every(Number.isFinite) &&
    job.timeRange[1] > job.timeRange[0]
  )
}

export async function exportVideo(
  job: VideoJob,
  placed: readonly Placed[],
  views: readonly View[],
  output: WritableStream<Uint8Array>,
  prepare: (at: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  progress: (value: VideoProgress) => void,
): Promise<void> {
  if (
    !Number.isSafeInteger(job.width) ||
    job.width < 4 ||
    job.width % 4 ||
    !Number.isSafeInteger(job.height) ||
    job.height < 2 ||
    job.height % 2 ||
    !Number.isFinite(job.frameRate) ||
    job.frameRate <= 0 ||
    !['medium', 'high', 'very-high'].includes(job.quality) ||
    !Number.isFinite(job.rate) ||
    job.rate <= 0 ||
    !job.timeRange.every(Number.isFinite) ||
    job.timeRange[1] <= job.timeRange[0]
  )
    throw new Error('Invalid MP4 export settings.')
  const [from, to] = job.timeRange
  const total = Math.max(1, Math.ceil(((to - from) / job.rate) * job.frameRate))
  if (!Number.isSafeInteger(total)) throw new Error('The video contains too many frames.')
  const bitrate =
    job.width *
    job.height *
    job.frameRate *
    { medium: 0.08, high: 0.15, 'very-high': 0.25 }[job.quality]
  if (!Number.isFinite(bitrate) || bitrate <= 0) throw new Error('Invalid MP4 bitrate.')
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

export function videoOutput(
  write: (bytes: Uint8Array) => Promise<void>,
  finish: () => Promise<void>,
  abort: (reason: unknown) => Promise<void>,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({ write, close: finish, abort })
}
