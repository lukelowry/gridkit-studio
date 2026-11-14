import { type Gpu, type Rect, View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Results, ViewState } from '../../shared/messages.js'
import { holdsPlot, plotName } from '../../shared/plots.js'
import { reader } from '../../shared/settings.js'
import { resultTiles } from '../latkit/results.js'
import { plotScene } from '../latkit/scenes.js'
import { nativeTheme } from '../latkit/theme.js'
import { plotCamera } from '../monitor/plot.js'

/** Views of the Monitor's plots, drawn only into pictures. */
interface PlotViews {
  /** Each plot's view, in the region of the picture it draws in. */
  readonly placed: ReadonlyArray<{ readonly view: View; readonly region: Rect }>
  /** Lets go of the views. */
  release(): void
}

/** The Monitor's plots of `results` as views drawn only into pictures, stacked in `region` as the
 *  Monitor stacks them, each over `range`: what a video or an image of the Monitor draws. Each
 *  fetches the samples it draws as a picture draws it, which waits for them. */
export async function plotViews(
  app: ViewState,
  results: Results,
  gpu: Gpu,
  range: TimeRange,
  region: Rect,
  signal: AbortSignal,
): Promise<PlotViews> {
  const settings = reader(app.settings)
  const theme = nativeTheme(settings, 'monitor')
  const plots = (app.plots ?? []).filter((plot) => holdsPlot(results, plot))
  const placed: Array<{ view: View; region: Rect }> = []
  const release = () => {
    for (const { view } of placed) view.destroy()
  }
  try {
    for (const [lane, plot] of plots.entries()) {
      const tiles = resultTiles(results.id, plot.table, plot.field, plot.id)
      const scene = plotScene(tiles, plot, settings, theme, plotName(app.summary?.definition, plot))
      const view = await View.create(null, scene, {
        gpu,
        sources: [tiles],
        camera: plotCamera(plot, range),
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
