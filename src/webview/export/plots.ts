import { type Gpu, type Rect, View } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Results, ViewState } from '../../shared/messages.js'
import { holdsPlot, plotName } from '../../shared/plots.js'
import { reader } from '../../shared/preferences.js'
import { type FrameReads, FrameWindow } from '../frames.js'
import { plotCamera, plotRequest } from '../monitor/plot.js'
import { plotScene } from '../scenes.js'
import { nativeTheme } from '../theme.js'

/** Views of the Monitor's plots, drawn only into pictures. */
interface PlotViews {
  /** Each plot's view, in the region of the picture it draws in. */
  readonly placed: ReadonlyArray<{ readonly view: View; readonly region: Rect }>
  /** Lets go of the views and the frames they draw. */
  release(): void
}

/** The Monitor's plots of `results` as views drawn only into pictures, stacked in `region` as the
 *  Monitor stacks them, each over `range` in a picture `columns` device pixels wide: what a video or
 *  an image of the Monitor draws. Their frames come through `reads`. */
export async function plotViews(
  app: ViewState,
  results: Results,
  gpu: Gpu,
  reads: FrameReads,
  range: TimeRange,
  region: Rect,
  columns: number,
  signal: AbortSignal,
): Promise<PlotViews> {
  const settings = reader(app.settings)
  const theme = nativeTheme(settings, 'monitor')
  const plots = (app.plots ?? []).filter((plot) => holdsPlot(results, plot))
  const frames: FrameWindow[] = []
  const placed: Array<{ view: View; region: Rect }> = []
  const release = () => {
    for (const { view } of placed) view.destroy()
    for (const frame of frames) frame.clear()
  }
  try {
    for (const [lane, plot] of plots.entries()) {
      const frame = new FrameWindow(reads)
      frames.push(frame)
      await frame.receive(
        plotRequest(results, plot, range, Math.ceil(columns * region[2])),
        results.frames,
        signal,
      )
      const source = frame.data!
      const scene = plotScene(
        source,
        plot,
        settings,
        theme,
        plotName(app.summary?.definition, plot),
      )
      const view = await View.create(null, scene, {
        gpu,
        sources: [source],
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
