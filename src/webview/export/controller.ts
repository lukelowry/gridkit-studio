import { Data, type Gpu, type Mark, type Placed, type Rect, type Tiles, View } from 'latkit'

import { fieldDefinition } from '../../shared/document.js'
import { type Cameras, type Results, type ViewState } from '../../shared/messages.js'
import { holdsPlot, plotName } from '../../shared/plots.js'
import { reader } from '../../shared/preferences.js'
import { bridge } from '../bridge.js'
import { FrameReads, FrameWindow } from '../frames.js'
import { borderMaps, streetMaps } from '../maps.js'
import { CaseProjection } from '../projections.js'
import { asset, createView, openGpu } from '../runtime.js'
import {
  caseFit,
  diagramScene,
  networkScene,
  plotScene,
  sceneBindings,
  sceneFields,
} from '../scenes.js'
import { nativeTheme, theme } from '../theme.js'
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
  const maps: Array<Data | Tiles> = []
  let marks: Mark[] = []
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
    const name = summary.name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')
    file = await bridge.request('videoOpen', { uri: shown.uri, name: `${name}.mp4` }, signal)
    if (file === null) return null
    const handle = file
    output = videoOutput(
      (bytes) => bridge.request('videoWrite', { file: handle, bytes }),
      async () => {
        saved = await bridge.request('videoClose', { file: handle })
        file = null
      },
      async () => {
        await bridge.request('videoClose', { file: handle, abort: true })
        file = null
      },
    )
    const cameras: Cameras = await bridge.request('cameras', { uri: shown.uri }, signal)
    gpu = await openGpu()
    signal.throwIfAborted()
    const fields = new Map<string, Set<string>>()
    for (const kind of job.views)
      if (kind !== 'monitor')
        for (const selection of sceneFields(definition, kind, app.bindings)) {
          const held = fields.get(selection.table) ?? new Set<string>()
          for (const field of selection.fields) held.add(field)
          fields.set(selection.table, held)
        }
    const selection = [...fields].map(([table, fields]) => ({ table, fields: [...fields] }))
    await projection.receive({ results: results.id, fields: selection }, selection, signal)
    const data = projection.slot.current!.data
    if (job.views.includes('network') && definition.drawing.geographic) {
      if (settings.get('network.map.source') === 'borders') {
        const loaded = await borderMaps(new URL(asset('latkit-assets')), theme().palette, signal)
        maps.push(...loaded.data)
        marks = loaded.marks
      } else if (settings.get('network.map.source') === 'streets') {
        const loaded = streetMaps(settings.get('network.map.tilesUrl'), theme().palette)
        maps.push(loaded.source)
        marks = loaded.marks
      }
    }
    const sampled = new Map<string, FrameWindow>()
    if (job.views.includes('network'))
      for (const binding of Object.values(app.bindings ?? {})) {
        if (fieldDefinition(definition, binding.table, binding.field)?.kind !== 'sampled') continue
        if (
          !results.outputs.some(
            (output) => output.table === binding.table && output.field === binding.field,
          )
        )
          continue
        const key = JSON.stringify([binding.table, binding.field])
        if (!sampled.has(key)) {
          const frame = new FrameWindow(reads)
          sampled.set(key, frame)
          frames.push(frame)
        }
      }
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
                pixels: job.width,
                bytes: Math.floor((32 * 1024 * 1024) / Math.max(1, sampled.size)),
              },
              results!.frames,
              at,
              abort,
            )) || changed
        }),
      )
      if (network && changed) {
        network.sources = [
          data,
          ...maps,
          ...[...sampled.values()].flatMap((frame) => (frame.data ? [frame.data] : [])),
        ]
      }
    }
    await prepare(job.timeRange[0], signal)

    const plots = (app.plots ?? []).filter((plot) => holdsPlot(results, plot))
    for (let index = 0; index < job.views.length; index++) {
      const kind = job.views[index]!
      const share = 1 / job.views.length
      const region: Rect =
        job.layout === 'row' ? [index * share, 0, share, 1] : [0, index * share, 1, share]
      if (kind === 'monitor') {
        for (let lane = 0; lane < plots.length; lane++) {
          const plot = plots[lane]!
          const frame = new FrameWindow(reads)
          frames.push(frame)
          await frame.receive(
            {
              results: results.id,
              table: plot.from,
              field: plot.field,
              ...(plot.id !== undefined ? { ids: [plot.id] } : {}),
              range: job.timeRange,
              purpose: 'plot',
              pixels: Math.ceil(job.width * region[2]),
              bytes: Math.floor((32 * 1024 * 1024) / Math.max(1, plots.length)),
            },
            results.frames,
            signal,
          )
          const source = frame.data!
          const view = await createView(
            null,
            plotScene(
              source,
              plot.from,
              plot.field,
              plotName(definition, plot),
              settings,
              nativeTheme(settings, 'monitor'),
            ),
            { gpu, sources: [source], camera: { x: [...job.timeRange] } },
          )
          view.at = job.timeRange[0]
          views.push(view)
          placed.push({
            view,
            region: [
              region[0],
              region[1] + (lane * region[3]) / plots.length,
              region[2],
              region[3] / plots.length,
            ],
          })
          signal.throwIfAborted()
        }
      } else {
        const bindings = sceneBindings(
          definition,
          app.bindings ?? {},
          results.outputs.map((output) => ({
            ...output,
            domain: results!.domains?.[output.table]?.[output.field],
          })),
          (table, field) => sampled.get(JSON.stringify([table, field]))?.data,
          settings,
        )
        const scene =
          kind === 'network'
            ? networkScene(
                data,
                definition.drawing,
                settings,
                nativeTheme(settings, kind),
                bindings,
                marks,
              )
            : diagramScene(data, definition.drawing, settings, nativeTheme(settings, kind), false)
        if (kind === 'network' && settings.get('network.map.source') === 'streets')
          scene.subtitle = settings.get('network.map.attribution')
        const view = await createView(null, scene, {
          gpu,
          sources: [
            data,
            ...maps,
            ...[...sampled.values()].flatMap((frame) => (frame.data ? [frame.data] : [])),
          ],
          ...(cameras[kind] ? { camera: cameras[kind] } : {}),
        })
        views.push(view)
        if (kind === 'network') {
          network = view
          view.orbit = settings.get('network.orbit')
          const camera = view.camera
          if ('pitch' in camera && camera.pitch !== settings.get('network.tilt'))
            view.camera = { ...camera, pitch: settings.get('network.tilt') }
        }
        view.at = job.timeRange[0]
        if (!cameras[kind]) view.fit(caseFit(data, definition.drawing, kind))
        placed.push({ view, region })
        signal.throwIfAborted()
      }
    }
    await exportVideo(job, placed, views, output, prepare, signal, progress)
    return saved
  } catch (error) {
    if (output && !output.locked) await output.abort(error).catch(() => {})
    throw error
  } finally {
    for (const view of views) view.destroy()
    gpu?.destroy()
    for (const frame of frames) frame.clear()
    projection.clear()
    reads.clear()
    for (const source of maps) if (source instanceof Data) source.destroy()
    if (file !== null) await bridge.request('videoClose', { file, abort: true }).catch(() => {})
    if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
  }
}
