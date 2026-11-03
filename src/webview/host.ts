import { type Fit, type Scene, View } from 'latkit'

import { drew } from './runtime.js'

/** A latkit view on a canvas, from its creation to its end: what the Network, the Diagram and each
 *  Monitor plot share. It marks its canvas once a frame draws it whole, waits on latkit as long as
 *  it lasts, and hands latkit a scene only when it draws differently from the last. */
export class ViewHost {
  readonly #lifetime = new AbortController()
  #fitting = Promise.resolve()
  #drawn: string

  private constructor(
    readonly view: View,
    readonly canvas: HTMLCanvasElement,
    scene: Scene,
    readonly fail: (error: unknown) => void,
  ) {
    this.#drawn = JSON.stringify(scene)
  }

  /** A view drawing `scene` on `canvas`; `drawn` hears once a frame first draws it whole. */
  static async open(
    canvas: HTMLCanvasElement,
    scene: Scene,
    options: Parameters<typeof View.create>[2],
    fail: (error: unknown) => void,
    drawn?: () => void,
  ): Promise<ViewHost> {
    const host = new ViewHost(await View.create(canvas, scene, options), canvas, scene, fail)
    void host.view.done({ signal: host.#lifetime.signal }).then(() => {
      canvas.dataset.rendered = 'true'
      drew()
      drawn?.()
    }, fail)
    return host
  }

  set scene(scene: Scene) {
    const drawn = JSON.stringify(scene)
    if (drawn === this.#drawn) return
    this.#drawn = drawn
    this.view.scene = scene
  }

  /** Frames `fit` once its rows have their places, however long they take to arrive. */
  fit(fit?: Fit): void {
    const fitting = this.view.fit(fit, { signal: this.#lifetime.signal })
    this.#fitting = fitting.then(
      () => {},
      () => {},
    )
    void fitting.catch(this.fail)
  }

  /** Resolves once the last fit asked for applies: until a view's first fit does, it shows only its
   *  background, so a picture taken sooner would too. */
  framed(): Promise<void> {
    return this.#fitting
  }

  destroy(): void {
    this.#lifetime.abort()
    delete this.canvas.dataset.rendered
    this.view.destroy()
  }
}
