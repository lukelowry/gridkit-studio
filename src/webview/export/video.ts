/** Render selected views of results into a video file: the Monitor's part from every sample over
 *  the time range, the Network's from samples that come a moment at a time, a few chunks ahead of
 *  the frame drawn. */

import { createDiagram } from '@latkit/diagram'
import { createComposition, type Gpu, type Positions, type View } from '@latkit/gpu'
import type { Data, Domain } from '@latkit/model'
import { createMonitor } from '@latkit/monitor'
import { createNetwork } from '@latkit/network'
import type { VideoProgress, VideoWrite } from '@latkit/video'

import type { Cameras, Plot, VideoView, ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { diagramOf, fieldName, networkOf } from '../../shared/schema.js'
import { diagrammed } from '../diagram/diagram.js'
import { diagramConfig } from '../diagram/style.js'
import { MAX_OUTPUT_PIXELS } from '../gpu.js'
import { axisLabel, PLOT_LIMITS, plotBindings, plotOptions, plotRows } from '../monitor/plot.js'
import { loadBorders } from '../network/borders.js'
import { isGeographic, projectionOf } from '../network/network.js'
import { networkConfig } from '../network/style.js'
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

/** What the export draws: the view state, the case's rows, those rows with every sample the
 *  Monitor's part plots, the samples the Network's part maps at each moment, where the case saves
 *  its diagram blocks, and each view's camera. */
interface VideoInputs {
  readonly state: ViewState
  readonly rows: Data
  readonly plotted: Data
  /** The rows with the samples the Network maps at `at`, once they are held. */
  readonly mapped: (at: number, signal: AbortSignal) => Promise<Data>
  readonly presentation: Readonly<Record<string, Positions>>
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
export function plotsOf({ results, plots = [] }: ViewState): Plot[] {
  return plots.filter((plot) =>
    results?.outputs.some(
      (output) => output.from === plot.from && output.select.includes(plot.field),
    ),
  )
}

/** Whether the export can start: a case with results, a view, a signal for the Monitor's part, a
 *  time range within the results, an even size up to 4K and a positive speed. */
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
    settings.width * settings.height <= MAX_OUTPUT_PIXELS &&
    settings.rate > 0
  )
}

/** Encodes the views to `output` on renderers of their own, so VS Code stays usable; colors span
 *  the whole run. Before each frame draws, the Network is given the samples of its moment. The
 *  caller closes or aborts `output`. */
export async function exportVideo(
  gpu: Gpu,
  settings: VideoSettings,
  { state, rows, plotted, mapped, presentation, cameras }: VideoInputs,
  output: WritableStream<VideoWrite>,
  signal: AbortSignal,
  onProgress: (progress: VideoProgress) => void,
): Promise<void> {
  const preferences = reader(state.settings)
  const { palette: colors, font: face } = theme()
  const still = { input: 'none', motion: 'reduce' } as const
  /** Each view's renderers, in selection order. */
  const cells: View[][] = []
  const made: View[] = []
  const keep = <V extends View>(view: V): V => {
    made.push(view)
    return view
  }
  /** Gives the Network the samples of the moment `at`, once they are held. */
  let ready = async (_at: number) => {}
  try {
    for (const view of settings.views) {
      if (view === 'network') {
        const geographic = isGeographic(rows)
        const borders =
          geographic && preferences.get('network.borders')
            ? await loadBorders().catch(() => null)
            : null
        const [start] = settings.timeRange
        let drawn = await mapped(start, signal)
        signal.throwIfAborted()
        const config = (data: Data, at: number) => ({
          ...networkConfig(rows, data, state, geographic, borders),
          at,
          ...still,
          canvas: null,
        })
        const network = keep(
          createNetwork(gpu, {
            ...config(drawn, start),
            camera: (cameras.network as never) ?? {
              projection: projectionOf(preferences.get('network.camera.projection'), geographic),
              fit: true,
            },
          }),
        )
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
          plots.map((plot) => {
            const definition = rows.schema.types[plot.from]?.fields[plot.field]
            return keep(
              createMonitor(gpu, {
                ...plotOptions(
                  preferences,
                  colors,
                  face,
                  axisLabel(rows.schema.axis),
                  fieldName(definition, plot.field),
                ),
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
                camera: { x: settings.timeRange, fit: preferences.get('monitor.camera.fit') },
                limits: PLOT_LIMITS,
              }),
            )
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
    const [start, end] = settings.timeRange
    await record(renderer, {
      output,
      width: settings.width,
      height: settings.height,
      duration: (end - start) / settings.rate,
      frameRate: settings.frameRate,
      format: settings.format,
      quality: { medium: 0.5, high: 0.75, 'very-high': 1 }[settings.quality],
      at: (seconds) => start + seconds * settings.rate,
      ready: (at) => (at === undefined ? undefined : ready(at)),
      signal,
      onProgress: (progress) => {
        if (!signal.aborted) onProgress(progress)
      },
    })
  } finally {
    for (const view of made.reverse()) view.destroy()
  }
}
