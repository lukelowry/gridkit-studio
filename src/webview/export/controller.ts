import { type Gpu, type Placed, type Rect, View } from 'latkit'

import { caseStem } from '../../shared/format.js'
import { type Results, type ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/settings.js'
import { bridge } from '../bridge.js'
import { CaseRows } from '../latkit/data.js'
import { PlayheadFeed } from '../latkit/frames.js'
import { openGpu } from '../latkit/load.js'
import { type Background, mapOf, NO_MAP } from '../latkit/maps.js'
import { caseFit, daylightOf, sampledFields, sceneFields, sceneOf } from '../latkit/scenes.js'
import { nativeTheme } from '../latkit/theme.js'
import { plotViews } from './plots.js'
import { exportVideo, framed, type VideoJob, type VideoProgress } from './video.js'

/** Renders `job` to a file, owning every resource: the results lease, the GPU and the file. */
export async function renderVideo(
  job: VideoJob,
  state: ViewState,
  signal: AbortSignal,
  progress: (value: VideoProgress) => void,
): Promise<string | null> {
  if (!state.summary || !state.uri || !state.results) throw new Error('No results to export.')
  const caseRows = new CaseRows()
  /** Whether the feed's frames changed since the Network view's sources were last set. */
  let changed = false
  // A failed read fails the video through the frame that waits on it.
  const feed = new PlayheadFeed({ changed: () => (changed = true), failed() {} })
  const views: View[] = []
  const placed: Placed[] = []
  const released: Array<() => void> = []
  let background: Background = NO_MAP
  let gpu: Gpu | undefined
  let results: Results | undefined
  let file: number | null = null
  let saved: string | null = null
  let output: WritableStream<Uint8Array> | undefined
  try {
    results = await bridge.request('share', { results: state.results.id }, signal)
    const leased = { ...state, results }
    const summary = state.summary
    const settings = reader(leased.settings)
    const definition = summary.definition
    const name = `${caseStem(summary.name)}.mp4`
    file = await bridge.request('exportOpen', { uri: state.uri, name }, signal)
    if (file === null) return null
    const handle = file
    // Encoded bytes go to the file as they are produced, one write at a time.
    output = new WritableStream<Uint8Array>({
      write: (bytes) => bridge.request('exportWrite', { file: handle, bytes }),
      async close() {
        saved = await bridge.request('exportClose', { file: handle })
        file = null
      },
      async abort() {
        await bridge.request('exportClose', { file: handle, abort: true })
        file = null
      },
    })
    const framing = await bridge.request('framing', { uri: state.uri }, signal)
    gpu = await openGpu()
    signal.throwIfAborted()
    const selection = job.views.includes('network') ? sceneFields(definition, leased.mappings) : []
    await caseRows.receive({ results: results.id, fields: selection }, selection, signal)
    const data = caseRows.slot.current!.data
    if (job.views.includes('network'))
      background = await mapOf(settings, definition.drawing.geographic, signal)
    const fields = job.views.includes('network')
      ? sampledFields(definition, leased.mappings, results)
      : []
    const sources = () => [data, ...background.sources, ...feed.sources]
    let network: View | undefined
    const pace = {
      results: { ...results, domain: job.timeRange },
      playing: true,
      rate: job.rate,
      frameRate: job.frameRate,
    }
    /** Loads the frames at `at` and those after it. */
    const prepare = async (at: number, abort: AbortSignal) => {
      await feed.ahead(fields, at, pace, abort)
      if (changed && network) network.sources = sources()
      changed = false
    }
    await prepare(job.timeRange[0], signal)

    for (let index = 0; index < job.views.length; index++) {
      const kind = job.views[index]!
      const share = 1 / job.views.length
      const region: Rect =
        job.layout === 'row' ? [index * share, 0, share, 1] : [0, index * share, 1, share]
      if (kind === 'monitor') {
        const lanes = await plotViews(leased, results, gpu, job.timeRange, region, signal)
        released.push(lanes.release)
        views.push(...lanes.placed.map(({ view }) => view))
        placed.push(...lanes.placed)
      } else {
        const scene = sceneOf(data, definition, settings, nativeTheme(settings, 'network'), {
          mappings: leased.mappings,
          results,
          sampled: feed.source,
          background,
          daylight: daylightOf(settings.get('network.map.daylight')),
        })
        // The user's framing in the Network if there is one, else the whole case.
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
    feed.clear()
    caseRows.clear()
    if (file !== null) await bridge.request('exportClose', { file, abort: true }).catch(() => {})
    if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
  }
}
