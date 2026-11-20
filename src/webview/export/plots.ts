import { type Gpu, type Rect, type Theme, View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Monitor, Results, ViewState } from '../../shared/messages.js'
import { isRecorded, monitorName } from '../../shared/monitors.js'
import { reader } from '../../shared/settings.js'
import type { ResultTiles } from '../latkit/results.js'
import { plotScene } from '../latkit/scenes.js'
import { plotCamera } from '../monitor/plot.js'

interface PlotViews {
  readonly placed: ReadonlyArray<{ readonly view: View; readonly region: Rect }>
  release(): void
}

/** Offscreen views of the shown monitors over `timeWindow`, side by side in `region` for a row and
 *  stacked for a column, as the Monitor shows them. Each fetches its samples as a shot draws it. */
export async function plotViews(
  state: ViewState,
  results: Results,
  gpu: Gpu,
  timeWindow: TimeRange,
  region: Rect,
  signal: AbortSignal,
  {
    sources,
    theme,
    direction,
  }: { readonly sources: ResultTiles; readonly theme: Theme; readonly direction: 'row' | 'column' },
): Promise<PlotViews> {
  const settings = reader(state.settings)
  const monitors: Monitor[] = (state.shown ?? []).filter((monitor) => isRecorded(results, monitor))
  const placed: Array<{ view: View; region: Rect }> = []
  const release = () => {
    for (const { view } of placed) view.destroy()
  }
  try {
    for (const [index, monitor] of monitors.entries()) {
      const tiles = sources.field(monitor.table, monitor.field, monitor.id)
      const name = monitorName(state.summary?.definition, monitor)
      const scene = plotScene(tiles, monitor, settings, theme, name)
      const view = await View.create(null, scene, {
        gpu,
        sources: [tiles],
        camera: plotCamera(monitor, timeWindow),
        signal,
      })
      const [x, y, width, height] = region
      const share = 1 / monitors.length
      placed.push({
        view,
        region:
          direction === 'row'
            ? [x + index * share * width, y, share * width, height]
            : [x, y + index * share * height, width, share * height],
      })
    }
    return { placed, release }
  } catch (error) {
    release()
    throw error
  }
}
