import { type Gpu, type Placed, type Rect, View } from 'latkit'

import { type Results, type ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { bridge } from '../bridge.js'
import { FrameReads, SampledWindows } from '../frames.js'
import { type Background, backgroundOf } from '../maps.js'
import { CaseProjection } from '../projections.js'
import { asset, openGpu } from '../runtime.js'
import { caseFit, sampledFields, sceneFields, sceneOf } from '../scenes.js'
import { nativeTheme, theme } from '../theme.js'
import { caseStem } from './image.js'
import { plotViews } from './plots.js'
import { exportVideo, framed, type VideoJob, videoOutput, type VideoProgress } from './video.js'

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
  /** The frames each mapped field of the results holds about the frame the video draws. */
  const sampled = new SampledWindows(reads)
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
    const framing = await bridge.request('framing', { uri: shown.uri }, signal)
    gpu = await openGpu()
    signal.throwIfAborted()
    const selection = job.views.includes('network') ? sceneFields(definition, app.bindings) : []
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
    const fields = job.views.includes('network')
      ? sampledFields(definition, app.bindings, results)
      : []
    const sources = () => [data, ...background.sources, ...sampled.sources]
    let network: View | undefined
    /** Holds each mapped field's frames from `at` to where half a second of the video reaches. */
    const prepare = async (at: number, abort: AbortSignal) => {
      let changed = false
      await Promise.all(
        fields.map(async ([table, field]) => {
          const window = sampled.of([table, field])
          const range = window.range
          if (range && at >= range[0] && at <= range[1]) return
          changed =
            (await window.playhead(
              {
                results: results!.id,
                table,
                field,
                range: [at, Math.min(job.timeRange[1], at + job.rate / 2)],
                purpose: 'playhead',
                bytes: Math.floor((32 * 1024 * 1024) / Math.max(1, fields.length)),
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
        const scene = sceneOf(data, definition, settings, nativeTheme(settings, 'network'), {
          bindings: app.bindings,
          results,
          sampled: sampled.source,
          background: background.marks,
        })
        if (background.attribution)
          scene.title = { text: background.attribution, place: 'bottom-right' }
        // What the user framed in the Network, as they framed it; else the whole case, as the
        // Network first frames it.
        const view = await View.create(null, scene, {
          gpu,
          sources: sources(),
          ...(framing && {
            camera: framed(framing, [region[2] * job.width, region[3] * job.height]),
          }),
        })
        views.push(view)
        network = view
        view.orbit = settings.get('network.orbit')
        view.at = job.timeRange[0]
        if (!framing) {
          view.camera = { pitch: settings.get('network.tilt') }
          void view.fit(caseFit(data, definition.drawing), { signal }).catch(bridge.report)
        }
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
    sampled.clear()
    projection.clear()
    reads.clear()
    background.destroy?.()
    if (file !== null) await bridge.request('exportClose', { file, abort: true }).catch(() => {})
    if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
  }
}
