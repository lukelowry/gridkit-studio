import { type Camera, type Placed, Shot, type Video } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { ExportStatus, Framing, VideoView, ViewState } from '../../shared/messages.js'
import { isRecorded } from '../../shared/monitors.js'
import type { ExportSettings } from '../../shared/settings.js'
import { monitorWindow } from '../monitor/plot.js'

/** What the Export view renders, as chosen in it. Unset times follow the Monitor's window and an
 *  unset rate the playback speed. */
export interface ExportChoices {
  readonly format: 'video' | 'image'
  readonly views: readonly VideoView[]
  readonly layout: 'column' | 'row'
  readonly from?: number
  readonly to?: number
  readonly rate?: number
}

export const CHOICES: ExportChoices = { format: 'video', views: ['network'], layout: 'column' }

/** An export, resolved: a video plays `timeRange` at `rate`, and an image shows its start. */
export interface ExportJob {
  readonly format: 'video' | 'image'
  readonly views: readonly VideoView[]
  readonly layout: 'column' | 'row'
  readonly timeRange: TimeRange
  readonly rate: number
  readonly settings: ExportSettings
}

/** The camera that fits what `framing`'s canvas showed into a `width` by `height` picture. Zoom is
 *  log₂ of pixels per unit, so scaling adds to it. */
export function framed({ camera, size }: Framing, [width, height]: readonly [number, number]) {
  if (!('zoom' in camera)) return camera
  const scale = Math.min(width / size[0], height / size[1])
  return { ...camera, zoom: camera.zoom + Math.log2(scale) } satisfies Camera
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

/** The span a video plays by default: the Monitor's window within the run. */
export function videoTimes(state: ViewState): TimeRange | undefined {
  const domain = state.results?.domain
  if (!domain || domain[1] <= domain[0]) return undefined
  const timeWindow = monitorWindow(state.results, state.window)
  const range: TimeRange = [Math.max(domain[0], timeWindow[0]), Math.min(domain[1], timeWindow[1])]
  return range[0] < range[1] ? range : undefined
}

/** Frames in a video of `job`: one per frame interval, plus one so it ends on its last time. */
export const framesOf = ({ timeRange: [from, to], rate, settings }: ExportJob) =>
  Math.ceil(((to - from) / rate) * settings['export.frameRate']) + 1

/** Why `job` cannot be exported, or nothing when it can. */
export function problemOf(job: ExportJob, state: ViewState): string | undefined {
  if (!job.views.length) return 'Choose a view to export.'
  if (
    job.views.includes('monitor') &&
    !state.shown?.some((each) => isRecorded(state.results, each))
  )
    return 'The Monitor shows no recorded signal.'
  if (job.format === 'image') return undefined
  const [from, to] = job.timeRange
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from))
    return 'Choose a time span that ends after it starts.'
  if (!(job.rate > 0 && Number.isFinite(job.rate))) return 'Choose a positive speed.'
  if (!Number.isSafeInteger(framesOf(job))) return 'The video would have too many frames.'
  return undefined
}

/** Encodes a video of `job` from the `placed` views to `output`. `prepare` loads each time's frames
 *  and moves every view there. */
export async function exportVideo(
  job: ExportJob,
  placed: readonly Placed[],
  output: WritableStream<Uint8Array>,
  prepare: (at: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  progress: (status: Omit<ExportStatus, 'name'>) => void,
): Promise<void> {
  const { settings } = job
  const [from, to] = job.timeRange
  const [width, height, fps] = [
    settings['export.width'],
    settings['export.height'],
    settings['export.frameRate'],
  ]
  const total = framesOf(job)
  const bitrate = width * height * fps * settings['export.bitsPerPixel']
  const shot = new Shot([width, height], {
    views: placed,
    scale: settings['export.scale'],
    capture: 'now',
  })
  let video: Video | undefined
  try {
    signal.throwIfAborted()
    video = shot.video({ fps, bitrate, output, signal })
    for (let frame = 0; frame < total; frame++) {
      signal.throwIfAborted()
      await prepare(Math.min(to, from + (frame / fps) * job.rate), signal)
      signal.throwIfAborted()
      await video.frame()
      progress({ done: frame + 1, total })
    }
    await video.finish()
  } catch (error) {
    if (video) await video.abort(error).catch(() => {})
    else await output.abort(error).catch(() => {})
    throw error
  }
}
