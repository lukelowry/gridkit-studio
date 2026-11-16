import { type Gpu, type Rect, View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Results, ViewState } from '../../shared/messages.js'
import { isRecorded, plotName } from '../../shared/plots.js'
import { reader } from '../../shared/settings.js'
import { resultTiles } from '../latkit/results.js'
import { plotScene } from '../latkit/scenes.js'
import { nativeTheme } from '../latkit/theme.js'
import { plotCamera } from '../monitor/plot.js'

interface PlotViews {
  readonly placed: ReadonlyArray<{ readonly view: View; readonly region: Rect }>
  release(): void
}

/** Offscreen views of the Monitor's plots over `timeWindow`, stacked in `region` as the Monitor
 *  stacks them, for images and videos. Each fetches its samples as a shot draws it. */
export async function plotViews(
  state: ViewState,
  results: Results,
  gpu: Gpu,
  timeWindow: TimeRange,
  region: Rect,
  signal: AbortSignal,
): Promise<PlotViews> {
  const settings = reader(state.settings)
  const theme = nativeTheme(settings, 'monitor')
  const plots = (state.plots ?? []).filter((plot) => isRecorded(results, plot))
  const placed: Array<{ view: View; region: Rect }> = []
  const release = () => {
    for (const { view } of placed) view.destroy()
  }
  try {
    for (const [lane, plot] of plots.entries()) {
      const tiles = resultTiles(results.id, plot.table, plot.field, plot.id)
      const name = plotName(state.summary?.definition, plot)
      const scene = plotScene(tiles, plot, settings, theme, name)
      const view = await View.create(null, scene, {
        gpu,
        sources: [tiles],
        camera: plotCamera(plot, timeWindow),
        signal,
      })
      const height = region[3] / plots.length
      placed.push({ view, region: [region[0], region[1] + lane * height, region[2], height] })
    }
    return { placed, release }
  } catch (error) {
    release()
    throw error
  }
}
