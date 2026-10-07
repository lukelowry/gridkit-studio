import { createGpu, type Gpu } from '@latkit/gpu'

/** The largest image a view draws or a video holds: 4K. */
export const MAX_OUTPUT_PIXELS = 3840 * 2160

/** An admission limit, not an allocation: a 4K canvas and a 4K export, each with old and new
 *  targets alive at 40 B/pixel (4x color, depth, resolve), plus 256 MiB for geometry and caches. */
const GPU_BUDGET = {
  gpuBytes: 4 * MAX_OUTPUT_PIXELS * 40 + 256 * 1024 ** 2,
  cpuBytes: 256 * 1024 ** 2,
  stagingBytes: 64 * 1024 ** 2,
}

/** The view's GPU, created on first request and again after the device is lost. */
export class CanvasGpu {
  gpu?: Gpu
  #pending?: Promise<Gpu>
  #closed = false
  /** Resolves the GPU; the `lost` of the call that creates it runs if it is lost while open. */
  async get(lost?: (reason: unknown) => void): Promise<Gpu> {
    if (this.gpu) return this.gpu
    return (this.#pending ??= createGpu({ budget: GPU_BUDGET, maxFramesInFlight: 2 })
      .then((gpu) => {
        if (this.#closed) {
          gpu.destroy()
          throw new Error('View closed')
        }
        this.gpu = gpu
        let failure: unknown
        // An uncaptured validation error can leave a canvas blank while its clock continues.
        // Discard the invalid device through the same recovery path as device loss.
        gpu.device.addEventListener(
          'uncapturederror',
          (event) => {
            failure = new Error('WebGPU: ' + event.error.message)
            gpu.destroy()
          },
          { once: true },
        )
        gpu.signal.addEventListener(
          'abort',
          () => {
            this.gpu = undefined
            this.#pending = undefined
            if (!this.#closed)
              lost?.(
                Object.assign(new Error('Graphics device lost. Recreating graphics.'), {
                  code: 'device-lost',
                  cause: failure ?? gpu.signal.reason,
                }),
              )
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
