import { type Gpu, type Placed, type Rect, View } from 'latkit'

import { type Cameras, type Results, type ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { bridge } from '../bridge.js'
import { FrameReads, FrameWindow } from '../frames.js'
import { type Background, backgroundOf } from '../maps.js'
import { CaseProjection } from '../projections.js'
import { asset, openGpu } from '../runtime.js'
import { caseFit, sampledFields, sceneFields, sceneOf } from '../scenes.js'
import { nativeTheme, theme } from '../theme.js'
import { caseStem } from './image.js'
import { plotViews } from './plots.js'
import { exportVideo, type VideoJob, videoOutput, type VideoProgress } from './video.js'

/** Owns every export resource, including its immutable results lease and sequential file sink. */
export async function renderVideo(
  job: VideoJob,
  shown: ViewState,
  signal: AbortSignal,
  progress: (value: VideoProgress) => void,
): Promise<string | null> {
  if (!shown.summary || !shown.uri || !shown.results) throw new Error('No results to export.')
  const projection = new CaseProjection()
  const reads = new FrameReads()
  const frames: FrameWindow[] = []
  const views: View[] = []
  const placed: Placed[] = []
  /** Lets go of the Monitor's plots, whose views and frames are their own. */
  const released: Array<() => void> = []
  let background: Background = { sources: [], marks: [] }
  let gpu: Gpu | undefined
  let results: Results | undefined
  let file: number | null = null
  let saved: string | null = null
  let output: WritableStream<Uint8Array> | undefined
  try {
    results = await bridge.request('share', { results: shown.results.id }, signal)
    const app = { ...shown, results }
    const summary = shown.summary
    const settings = reader(app.settings)
    const definition = summary.definition
    const name = `${caseStem(summary.name)}.mp4`
    file = await bridge.request('exportOpen', { uri: shown.uri, name }, signal)
    if (file === null) return null
    const handle = file
    output = videoOutput(
      (bytes) => bridge.request('exportWrite', { file: handle, bytes }),
      async () => {
        saved = await bridge.request('exportClose', { file: handle })
        file = null
      },
      async () => {
        await bridge.request('exportClose', { file: handle, abort: true })
        file = null
      },
    )
    const cameras: Cameras = await bridge.request('cameras', { uri: shown.uri }, signal)
    gpu = await openGpu()
    signal.throwIfAborted()
    const canvases = job.views.filter((kind) => kind !== 'monitor')
    const selection = sceneFields(definition, canvases, app.bindings)
    await projection.receive({ results: results.id, fields: selection }, selection, signal)
    const data = projection.slot.current!.data
    if (job.views.includes('network') && definition.drawing.geographic)
      background = await backgroundOf(
        settings.get('network.map.source'),
        settings,
        new URL(asset('latkit-assets')),
        theme().palette,
        signal,
      )
    const sampled = new Map<string, FrameWindow>()
    if (job.views.includes('network'))
      for (const field of sampledFields(definition, app.bindings, results)) {
        const frame = new FrameWindow(reads)
        sampled.set(JSON.stringify(field), frame)
        frames.push(frame)
      }
    const sources = () => [
      data,
      ...background.sources,
      ...[...sampled.values()].flatMap((frame) => (frame.data ? [frame.data] : [])),
    ]
    let network: View | undefined
    const prepare = async (at: number, abort: AbortSignal) => {
      let changed = false
      await Promise.all(
        [...sampled].map(async ([key, frame]) => {
          const [table, field] = JSON.parse(key) as [string, string]
          const range = frame.range
          if (range && at >= range[0] && at <= range[1]) return
          changed =
            (await frame.playhead(
              {
                results: results!.id,
                table,
                field,
                range: [at, Math.min(job.timeRange[1], at + job.rate / 2)],
                purpose: 'playhead',
                bytes: Math.floor((32 * 1024 * 1024) / Math.max(1, sampled.size)),
              },
              results!.frames,
              at,
              abort,
            )) || changed
        }),
      )
      if (network && changed) network.sources = sources()
    }
    await prepare(job.timeRange[0], signal)

    for (let index = 0; index < job.views.length; index++) {
      const kind = job.views[index]!
      const share = 1 / job.views.length
      const region: Rect =
        job.layout === 'row' ? [index * share, 0, share, 1] : [0, index * share, 1, share]
      if (kind === 'monitor') {
        const lanes = await plotViews(
          app,
          results,
          gpu,
          reads,
          job.timeRange,
          region,
          job.width,
          signal,
        )
        released.push(lanes.release)
        views.push(...lanes.placed.map(({ view }) => view))
        placed.push(...lanes.placed)
      } else {
        const scene = sceneOf(kind, data, definition, settings, nativeTheme(settings, kind), {
          bindings: app.bindings,
          results,
          sampled: (table, field) => sampled.get(JSON.stringify([table, field]))?.data,
          background: background.marks,
        })
        if (kind === 'network' && background.attribution) scene.subtitle = background.attribution
        const view = await View.create(null, scene, {
          gpu,
          sources: sources(),
          ...(cameras[kind] ? { camera: cameras[kind] } : {}),
        })
        views.push(view)
        if (kind === 'network') {
          network = view
          view.orbit = settings.get('network.orbit')
          view.camera = { pitch: settings.get('network.tilt') }
        }
        view.at = job.timeRange[0]
        if (!cameras[kind])
          void view.fit(caseFit(data, definition.drawing, kind), { signal }).catch(bridge.report)
        placed.push({ view, region })
        signal.throwIfAborted()
      }
    }
    await exportVideo(job, placed, output, prepare, signal, progress)
    return saved
  } catch (error) {
    if (output && !output.locked) await output.abort(error).catch(() => {})
    throw error
  } finally {
    for (const release of released) release()
    for (const view of views) view.destroy()
    gpu?.destroy()
    for (const frame of frames) frame.clear()
    projection.clear()
    reads.clear()
    background.destroy?.()
    if (file !== null) await bridge.request('exportClose', { file, abort: true }).catch(() => {})
    if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
  }
}
