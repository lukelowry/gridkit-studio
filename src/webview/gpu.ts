import { createGpu, type Gpu } from '@latkit/gpu'

/** A view's limit that never refuses work. latkit refuses a frame past any of its views' limits, such
 *  as rows drawn, geometry held or layout time; Studio sets none, so only the device and the memory
 *  it has bound what a case draws. */
export const UNLIMITED = Number.MAX_SAFE_INTEGER

/** What the view's memory pool keeps for reuse once nothing holds it: enough for a 4K canvas's and
 *  a 4K export's targets, old and new, at 40 B a pixel, beside 256 MiB of geometry and caches. It
 *  never limits what a frame draws: past it the pool lets go of what no one holds, least recently
 *  used first. */
const GPU_BUDGET = {
  gpuBytes: 4 * 3840 * 2160 * 40 + 256 * 1024 ** 2,
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
