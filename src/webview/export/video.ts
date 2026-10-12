/** Render selected views of results into a video file: the Monitor's part from every sample over
 *  the time range, the Network's from samples that come a moment at a time, a few chunks ahead of
 *  the frame drawn. */

import { createDiagram } from '@latkit/diagram'
import {
  createComposition,
  type Gpu,
  kit,
  type Layout,
  type ProjectedCamera,
  type View,
} from '@latkit/gpu'
import type { Data, Domain } from '@latkit/model'
import { createMonitor, type Monitor } from '@latkit/monitor'
import { createNetwork } from '@latkit/network'
import type { VideoProgress, VideoWrite } from '@latkit/video'

import type { Cameras, Plot, VideoView, ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { diagramOf, fieldName, networkOf, typeName } from '../../shared/schema.js'
import { diagrammed } from '../diagram/diagram.js'
import { diagramConfig } from '../diagram/style.js'
import {
  axisLabel,
  PLOT_LIMITS,
  plotBindings,
  plotOptions,
  plotRows,
  streamedValues,
} from '../monitor/plot.js'
import { isFlat, isGeographic, projectionOf } from '../network/network.js'
import { networkConfig } from '../network/style.js'
import { leastWants, type Wants } from '../samples.js'
import { theme } from '../theme.js'

export interface VideoSettings {
  readonly views: readonly VideoView[]
  readonly layout: 'column' | 'row'
  readonly timeRange: Domain
  /** Simulated seconds per second of video. */
  readonly rate: number
  readonly format: 'mp4' | 'webm'
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly quality: 'medium' | 'high' | 'very-high'
}

export const DEFAULTS: VideoSettings = {
  views: ['network'],
  layout: 'column',
  timeRange: [0, 0],
  rate: 1,
  format: 'mp4',
  width: 1920,
  height: 1080,
  frameRate: 30,
  quality: 'high',
}

/** What the export draws: the view state, the case's rows, those rows with the samples the
 *  Monitor's part plots, the samples the Network's part maps at each moment, where the case saves
 *  its diagram blocks, and each view's camera. */
interface VideoInputs {
  readonly state: ViewState
  readonly rows: Data
  /** The rows with every sample the Monitor's part plots over the time range; with `stream`, those
   *  of its first slice. */
  readonly plotted: Data
  /** For a time range holding more samples than a page keeps: the rows with the next slice of them,
   *  from where the plots' drawing stands, the slices before let go; undefined once drawn. */
  readonly stream?: (wants: Wants) => Promise<Data | undefined>
  /** The rows with the samples the Network maps at `at`, once they are held. */
  readonly mapped: (at: number, signal: AbortSignal) => Promise<Data>
  readonly presentation: Readonly<Record<string, Layout.Positions>>
  readonly cameras: Cameras
}

/** The views `state`'s case has anything to show in. */
export function viewsOf(state: ViewState): { value: VideoView; label: string }[] {
  const { summary } = state
  if (!summary) return []
  const drawn = (types: readonly string[]) => types.some((type) => summary.counts[type])
  return [
    ...(drawn(networkOf(summary.schema).vertices)
      ? [{ value: 'network' as const, label: 'Network' }]
      : []),
    ...(drawn(diagramOf(summary.schema).vertices)
      ? [{ value: 'diagram' as const, label: 'Diagram' }]
      : []),
    { value: 'monitor', label: 'Monitor' },
  ]
}

/** The plots of `state` its results hold, which the Monitor's part of a video draws. */
function plotsOf({ results, plots = [] }: ViewState): Plot[] {
  return plots.filter((plot) =>
    results?.outputs.some(
      (output) => output.from === plot.from && output.select.includes(plot.field),
    ),
  )
}

/** Starts reading the map a network on Earth shows, as soon as the page knows the case, so an
 *  export never waits for it. Only a case on Earth loads the map's code. A map that fails says so
 *  in the Network view. */
export function prefetchMap(state: ViewState): void {
  if (state.summary && networkOf(state.summary.schema).geographic)
    void import('../network/map.js')
      .then((maps) => maps.loadMap(reader(state.settings)))
      .catch(() => {})
}

/** Whether the export can start: a case with results, a view, a signal for the Monitor's part, a
 *  time range within the results, an even size and a positive speed. */
export function exportable(settings: VideoSettings, state: ViewState): boolean {
  const range = state.results?.domain
  if (!state.summary || !range || !(range[1] > range[0])) return false
  if (settings.views.length === 0) return false
  if (settings.views.includes('monitor') && plotsOf(state).length === 0) return false
  const [start, end] = settings.timeRange
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= range[0] &&
    end <= range[1] &&
    end > start &&
    [settings.width, settings.height].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n % 2 === 0,
    ) &&
    settings.rate > 0
  )
}

/** Encodes the views to `output` on renderers of their own, so VS Code stays usable; colors span
 *  the whole run. Before each frame draws, the Network is given the samples of its moment. The
 *  caller closes or aborts `output`. */
export async function exportVideo(
  gpu: Gpu,
  settings: VideoSettings,
  { state, rows, plotted, stream, mapped, presentation, cameras }: VideoInputs,
  output: WritableStream<VideoWrite>,
  cancel: AbortSignal,
  onProgress: (progress: VideoProgress) => void,
): Promise<void> {
  const preferences = reader(state.settings)
  const { palette: colors, font: face } = theme()
  const still = { input: 'none', motion: 'reduce' } as const
  /** A view that fails stops the export, which then says why. */
  const failed = new AbortController()
  const signal = AbortSignal.any([cancel, failed.signal])
  /** Each view's renderers, in selection order. */
  const cells: View[][] = []
  const made: View[] = []
  const keep = <V extends View>(view: V): V => {
    made.push(view)
    view.on('error', (reason) => failed.abort(reason))
    return view
  }
  /** Gives the Network the samples of the moment `at`, once they are held. */
  let ready = async (_at: number) => {}
  /** The Monitor's part's plots, which a streamed time range draws before the video records. */
  const lanes: Monitor[] = []
  try {
    for (const view of settings.views) {
      if (view === 'network') {
        const geographic = isGeographic(rows)
        const camera = (cameras.network as Partial<ProjectedCamera> | undefined) ?? {
          projection: projectionOf(preferences.get('network.camera.projection'), geographic),
          fit: true,
        }
        // Only a case on Earth loads the map's code. The view has said once why a map failed to
        // load; the video then shows the ground alone.
        const maps = geographic ? await import('../network/map.js') : undefined
        const map = maps && (await maps.loadMap(preferences).catch(() => null))
        const flat = isFlat(camera.projection ?? 'flat')
        const earth = maps
          ? keep(
              maps.mountEarth(gpu, {
                ...maps.mapConfig(preferences, colors, face, map ?? null, flat),
                ...still,
              }),
            )
          : null
        const [start] = settings.timeRange
        let drawn = await mapped(start, signal)
        signal.throwIfAborted()
        const config = (data: Data, at: number) => ({
          ...networkConfig(rows, data, state, earth),
          at,
          ...still,
          canvas: null,
        })
        const network = keep(createNetwork(gpu, { ...config(drawn, start), camera }))
        ready = async (at) => {
          const data = await mapped(at, signal)
          if (data === drawn) return
          drawn = data
          network.set({ ...config(data, at), camera: network.camera }, { replace: true })
        }
        cells.push([network])
      } else if (view === 'diagram') {
        if (!diagrammed(rows)) throw new Error('This case has no diagram to export.')
        const diagram = keep(
          createDiagram(gpu, {
            ...diagramConfig(rows, { ...state, diagramEditing: false }, presentation),
            ...still,
            canvas: null,
            ...(cameras.diagram !== undefined && { camera: cameras.diagram as never }),
          }),
        )
        cells.push([diagram])
      } else {
        const plots = plotsOf(state)
        if (plots.length === 0) throw new Error('No recorded signal to export.')
        cells.push(
          plots.map((plot, i) => {
            const definition = rows.schema.types[plot.from]?.fields[plot.field]
            // Nothing beside a video names its plots, so each names itself as the Monitor's
            // header does; the last, over the time axis they share, labels and captions its ticks.
            const name =
              typeName(rows.schema, plot.from) +
              (plot.id ? ` ${plot.id.slice(plot.from.length + 1)}` : '') +
              ` · ${fieldName(definition, plot.field)}`
            const last = i === plots.length - 1
            // A streamed plot spans its field's measured range, as the Monitor's own does.
            const values = stream && streamedValues(state.results, plot)
            const monitor = keep(
              createMonitor(gpu, {
                ...plotOptions(preferences, colors, face, {
                  ticks: last,
                  caption: name,
                  ...(last && { time: axisLabel(rows.schema.axis) }),
                }),
                ...still,
                canvas: null,
                source: plotted,
                ...plotBindings(
                  preferences,
                  { type: plot.from, field: plot.field, ...(plot.id && { id: plot.id }) },
                  state.bindings,
                  plotRows(plotted, state.results, {
                    type: plot.from,
                    field: plot.field,
                    id: plot.id,
                  }),
                  state.results,
                ),
                camera: values
                  ? { x: settings.timeRange, y: values, fit: false }
                  : { x: settings.timeRange, fit: preferences.get('monitor.camera.fit') },
                limits: PLOT_LIMITS,
                ...(stream && { frames: 'stable' as const }),
              }),
            )
            lanes.push(monitor)
            return monitor
          }),
        )
      }
    }
    // Views split the frame along the arrangement; several plots stack within their view's share.
    const regions = cells.flatMap((views, at) => {
      const share = 1 / cells.length
      const [x, y, width, height] =
        settings.layout === 'row' ? [at * share, 0, share, 1] : [0, at * share, 1, share]
      return views.map((view, lane) => ({
        view,
        region: [x!, y! + (lane * height!) / views.length, width!, height! / views.length] as const,
      }))
    })
    const renderer =
      regions.length === 1
        ? regions[0]!.view
        : keep(createComposition(gpu, { views: regions, background: colors.background }))
    const { exportVideo: record } = await import('@latkit/video')
    signal.throwIfAborted()
    if (stream && lanes.length) await prime(gpu, renderer, lanes, stream, settings, signal)
    const [start, end] = settings.timeRange
    await record(renderer, {
      output,
      width: settings.width,
      height: settings.height,
      duration: (end - start) / settings.rate,
      frameRate: settings.frameRate,
      format: settings.format,
      quality: { medium: 0.5, high: 0.75, 'very-high': 1 }[settings.quality],
      at: async (seconds) => {
        const at = start + seconds * settings.rate
        await ready(at)
        return at
      },
      signal,
      onProgress: (progress) => {
        if (!signal.aborted) onProgress(progress)
      },
    })
  } finally {
    for (const view of made.reverse()) view.destroy()
  }
}

/**
 * Draws the plots' history of the whole time range before the video records, its samples streamed
 * through them a slice at a time, so every frame of the video shows the plots whole. The plots draw
 * at the video's size, into the history its frames then show.
 */
async function prime(
  gpu: Gpu,
  view: View,
  plots: readonly Monitor[],
  stream: (wants: Wants) => Promise<Data | undefined>,
  settings: VideoSettings,
  signal: AbortSignal,
): Promise<void> {
  const target = kit.createPresentation(gpu, {
    canvas: new OffscreenCanvas(settings.width, settings.height),
    alphaMode: 'opaque',
  })
  const viewport = { width: settings.width, height: settings.height, pixelRatio: 1 }
  try {
    for (;;) {
      await gpu.render({
        completion: 'complete',
        signal,
        timeMs: 0,
        views: [
          {
            renderer: kit.rendererOf(view),
            target,
            at: settings.timeRange[0],
            viewport,
            presented: false,
          },
        ],
      })
      const data = await stream(leastWants(plots.map((plot) => plot.stats().wants)))
      signal.throwIfAborted()
      if (!data) return
      for (const plot of plots) plot.set({ source: data })
    }
  } finally {
    target.destroy()
  }
}
