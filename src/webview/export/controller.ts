import { type Gpu, type Placed, type Rect, Shot, View } from 'latkit'

import { caseStem, formatTime } from '../../shared/format.js'
import type { ExportStatus, Results, ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/settings.js'
import { bridge } from '../bridge.js'
import { CaseRows } from '../latkit/data.js'
import { PlayheadFeed } from '../latkit/frames.js'
import { openGpu } from '../latkit/load.js'
import { mapOf } from '../latkit/maps.js'
import { ResultTiles } from '../latkit/results.js'
import {
  captionScene,
  caseFit,
  daylightOf,
  sampledFields,
  sceneFields,
  sceneOf,
} from '../latkit/scenes.js'
import { nativeTheme, networkLook } from '../latkit/theme.js'
import { imageOptions, saveImage } from './image.js'
import { plotViews } from './plots.js'
import { type ExportJob, exportVideo, framed, videoTimes } from './video.js'

/** The caption band's height in CSS pixels: a title and a subtitle line. */
const CAPTION_HEIGHT = 64

interface Composition {
  readonly placed: Placed[]
  /** Loads the frames at `at` and those after it, and moves every view there. */
  prepare(at: number, signal: AbortSignal): Promise<void>
  release(): void
}

/** The views of `job`, each in its region of the frame, under a caption band if it has one. */
async function compose(
  job: ExportJob,
  state: ViewState,
  results: Results,
  gpu: Gpu,
  signal: AbortSignal,
): Promise<Composition> {
  const summary = state.summary!
  const definition = summary.definition
  const settings = reader(state.settings)
  const style = job.settings
  const themeOf = (kind: 'network' | 'monitor') => nativeTheme(kind, style['export.theme'])
  const caseRows = new CaseRows()
  /** Whether the feed's frames changed since the Network view's sources were last set. */
  let changed = false
  // A failed read fails the export through the frame that waits on it.
  const feed = new PlayheadFeed({ changed: () => (changed = true), failed() {} })
  /** Every view made, each destroyed once with the composition. */
  const views: View[] = []
  const placed: Placed[] = []
  const release = () => {
    for (const view of views) view.destroy()
    feed.clear()
    caseRows.clear()
  }
  try {
    const height = style['export.height'] / style['export.scale']
    const band = style['export.caption'] ? Math.min(0.5, CAPTION_HEIGHT / height) : 0
    const title = caseStem(summary.name)
    const time = (at: number) => `t = ${formatTime(at, results.domain)} s`
    // The caption takes the background of the first view, which it sits above.
    const captionTheme = themeOf(job.views[0] ?? 'network')
    let caption: View | undefined
    if (band) {
      caption = await View.create(null, captionScene(captionTheme, title, time(job.timeRange[0])), {
        gpu,
        signal,
      })
      views.push(caption)
      placed.push({ view: caption, region: [0, 0, 1, band] })
    }
    let prepareNetwork: Composition['prepare'] | undefined
    // A video's plots span the video, and an image's the Monitor's window.
    const window = job.format === 'video' ? job.timeRange : (videoTimes(state) ?? results.domain)
    const fill: Rect = [0, band, 1, 1 - band]
    for (const [index, kind] of job.views.entries()) {
      const share = 1 / job.views.length
      const region: Rect =
        job.layout === 'row'
          ? [index * share, fill[1], share, fill[3]]
          : [0, fill[1] + index * share * fill[3], 1, share * fill[3]]
      if (kind === 'monitor') {
        const lanes = await plotViews(state, results, gpu, window, region, signal, {
          sources: new ResultTiles(results.id),
          theme: themeOf('monitor'),
          direction:
            region[2] * style['export.width'] >= 2 * region[3] * style['export.height']
              ? 'row'
              : 'column',
        })
        placed.push(...lanes.placed)
        views.push(...lanes.placed.map(({ view }) => view))
        continue
      }
      const selection = sceneFields(definition, state.mappings, settings.get('network.labels'))
      await caseRows.receive({ results: results.id, fields: selection }, selection, signal)
      const data = caseRows.slot.current!.data
      const background = await mapOf(settings, definition.drawing.geographic, signal)
      const framing = await bridge.request('framing', { uri: summary.uri }, signal)
      const fields = sampledFields(definition, state.mappings, results)
      const pace = {
        results: { ...results, domain: job.timeRange },
        playing: job.format === 'video',
        rate: job.rate,
        frameRate: style['export.frameRate'],
      }
      // The first scene needs the sampled fields that will drive it.
      await feed.ahead(fields, job.timeRange[0], pace, signal)
      const sources = () => [data, ...background.sources, ...feed.sources]
      const scene = sceneOf(
        data,
        definition,
        settings,
        networkLook(settings, style['export.theme']),
        {
          mappings: state.mappings,
          results,
          sampled: feed.source,
          background,
          daylight: daylightOf(settings.get('map.daylight')),
          legends: style['export.legend'],
        },
      )
      const size = [
        (region[2] * style['export.width']) / style['export.scale'],
        (region[3] * style['export.height']) / style['export.scale'],
      ] as const
      // The user's framing in the Network if there is one, else the whole case.
      const view = await View.create(null, scene, {
        gpu,
        signal,
        sources: sources(),
        ...(framing && { camera: framed(framing, size) }),
      })
      views.push(view)
      changed = false
      prepareNetwork = async (at, abort) => {
        await feed.ahead(fields, at, pace, abort)
        if (changed) view.sources = sources()
        changed = false
      }
      view.orbit = settings.get('network.orbit')
      if (!framing) {
        view.camera = { pitch: settings.get('network.tilt') }
        void view.fit(caseFit(data, definition.drawing), { signal }).catch(bridge.report)
      }
      placed.push({ view, region })
      signal.throwIfAborted()
    }
    const captionView = caption
    return {
      placed,
      release,
      async prepare(at, abort) {
        await prepareNetwork?.(at, abort)
        for (const view of views) view.at = at
        // The subtitle follows the time each frame shows.
        if (captionView) captionView.scene = captionScene(captionTheme, title, time(at))
      },
    }
  } catch (error) {
    release()
    throw error
  }
}

/** Renders `job` to a file, owning every resource: the results lease, the GPU and the file. Reports
 *  progress from when the file is chosen. Resolves with the saved path, or null if cancelled. */
export async function renderExport(
  job: ExportJob,
  state: ViewState,
  signal: AbortSignal,
  progress: (status: ExportStatus) => void,
): Promise<string | null> {
  if (!state.summary || !state.uri || !state.results) throw new Error('No results to export.')
  let gpu: Gpu | undefined
  let results: Results | undefined
  let composition: Composition | undefined
  let file: number | null = null
  let saved: string | null = null
  let output: WritableStream<Uint8Array> | undefined
  try {
    results = await bridge.request('share', { results: state.results.id }, signal)
    const leased = { ...state, results }
    if (job.format === 'image') {
      gpu = await openGpu()
      composition = await compose(job, leased, results, gpu, signal)
      await composition.prepare(job.timeRange[0], signal)
      const options = imageOptions(job.settings)
      // An image waits until transitions and camera flights end; a video freezes each frame.
      const shot = new Shot([job.settings['export.width'], job.settings['export.height']], {
        scale: options.scale,
        transparent: options.transparent,
        capture: 'still',
        views: composition.placed,
      })
      return await saveImage(
        shot,
        state.uri,
        state.summary.name,
        job.views.join('-'),
        options,
        signal,
      )
    }
    const name = `${caseStem(state.summary.name)}.mp4`
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
    progress({ name, done: 0, total: 1 })
    gpu = await openGpu()
    signal.throwIfAborted()
    composition = await compose(job, leased, results, gpu, signal)
    await exportVideo(job, composition.placed, output, composition.prepare, signal, (status) =>
      progress({ name, ...status }),
    )
    return saved
  } catch (error) {
    if (output && !output.locked) await output.abort(error).catch(() => {})
    throw error
  } finally {
    composition?.release()
    gpu?.destroy()
    if (file !== null) await bridge.request('exportClose', { file, abort: true }).catch(() => {})
    if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
  }
}
