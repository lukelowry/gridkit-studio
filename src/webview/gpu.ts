import { createGpu, type Gpu } from '@latkit/gpu'

/** The largest image a view draws or a video holds: 4K. */
export const MAX_OUTPUT_PIXELS = 3840 * 2160

/** Lattice's budget: a 4K canvas and a 4K export, each with old and new targets alive, at 40 bytes
 *  a pixel for 4x color, depth and the resolved image, plus 256 MiB for geometry and caches. An
 *  admission limit, not an allocation; ordinary windows use much less. */
const GPU_BUDGET = {
  gpuBytes: 4 * MAX_OUTPUT_PIXELS * 40 + 256 * 1024 ** 2,
  cpuBytes: 256 * 1024 ** 2,
  stagingBytes: 64 * 1024 ** 2,
}

/** The view's GPU: made when first asked for, and again once it stops. */
export class CanvasGpu {
  gpu?: Gpu
  #pending?: Promise<Gpu>
  #closed = false
  /** The GPU, calling `lost` if it stops while the view is open. */
  async get(lost: () => void): Promise<Gpu> {
    if (this.gpu) return this.gpu
    return (this.#pending ??= createGpu({ budget: GPU_BUDGET, maxFramesInFlight: 2 })
      .then((gpu) => {
        if (this.#closed) {
          gpu.destroy()
          throw new Error('View closed')
        }
        this.gpu = gpu
        gpu.signal.addEventListener(
          'abort',
          () => {
            this.gpu = undefined
            this.#pending = undefined
            if (!this.#closed) lost()
          },
          { once: true },
        )
        return gpu
      })
      .catch((error) => {
        this.#pending = undefined
        throw error
      }))
  }
  dispose() {
    this.#closed = true
    this.gpu?.destroy()
    this.gpu = undefined
  }
}
