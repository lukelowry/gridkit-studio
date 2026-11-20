import { type Fit, type Scene, View } from 'latkit'

import { clearStopped } from './load.js'

/** A latkit view on a canvas, marked ready once its first complete frame draws. */
export class CanvasView {
  readonly #lifetime = new AbortController()
  #fitting = Promise.resolve()

  private constructor(
    readonly view: View,
    readonly canvas: HTMLCanvasElement,
    readonly fail: (error: unknown) => void,
  ) {}

  /** `drawn` is called once a frame first draws the view completely. */
  static async open(
    canvas: HTMLCanvasElement,
    scene: Scene,
    options: Parameters<typeof View.create>[2],
    fail: (error: unknown) => void,
    drawn?: () => void,
  ): Promise<CanvasView> {
    const opened = new CanvasView(await View.create(canvas, scene, options), canvas, fail)
    void opened.view.done({ signal: opened.lifetime }).then(() => {
      canvas.dataset.rendered = 'true'
      clearStopped()
      drawn?.()
    }, fail)
    return opened
  }

  /** Aborts when the view is destroyed, ending every wait on latkit. */
  get lifetime(): AbortSignal {
    return this.#lifetime.signal
  }

  /** Applies `fit` once the rows are placed, however long they take to arrive. */
  fit(fit?: Fit): void {
    const fitting = this.view.fit(fit, { signal: this.lifetime })
    this.#fitting = fitting.then(
      () => {},
      () => {},
    )
    void fitting.catch(this.fail)
  }

  /** Resolves once the last requested fit applies. Before its first fit, a view shows only its
   *  background, and so would an image of it. */
  framed(): Promise<void> {
    return this.#fitting
  }

  destroy(): void {
    this.#lifetime.abort()
    delete this.canvas.dataset.rendered
    this.view.destroy()
  }
}
