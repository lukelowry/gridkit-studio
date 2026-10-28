import { Gpu, load, View } from 'latkit'

let loading: Promise<void> | undefined
let workerUrl: string | undefined
let ended = false
const workers = new Set<Worker>()

export function asset(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
  if (!value) throw new Error(`Missing bundled asset: ${name}`)
  return value
}

// load() compares the factory identity when more than one component initializes it.
function createWorker(): Worker {
  if (!workerUrl || ended) throw new Error('The Latkit worker is unavailable.')
  const worker = new Worker(workerUrl)
  workers.add(worker)
  return worker
}

export function loadRenderer(): Promise<void> {
  return (loading ??= (async () => {
    if (ended) throw new Error('The webview is closed.')
    try {
      // Native jobs start on demand, after initialization. Fetch the standalone bundle while
      // load() compiles WASM and starts the GPU, then publish only when both are ready.
      const results = await Promise.allSettled([
        load({ wasm: asset('latkit-wasm'), worker: createWorker }),
        (async () => {
          const response = await fetch(asset('latkit-worker'))
          if (!response.ok)
            throw new Error(`Could not load the Latkit worker (${response.status}).`)
          return response.text()
        })(),
      ])
      for (const result of results) if (result.status === 'rejected') throw result.reason
      if (ended) throw new Error('The webview is closed.')
      const source = results[1]
      if (source.status === 'fulfilled')
        workerUrl = URL.createObjectURL(new Blob([source.value], { type: 'text/javascript' }))
    } catch (error) {
      for (const worker of workers) worker.terminate()
      workers.clear()
      if (workerUrl) URL.revokeObjectURL(workerUrl)
      workerUrl = undefined
      throw error
    }
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  }))
}

export async function openGpu(): Promise<Gpu> {
  await loadRenderer()
  const gpu = await Gpu.create()
  if (ended) {
    gpu.destroy()
    throw new Error('The webview is closed.')
  }
  const available = gpu.budget
  gpu.budget = {
    bytes: Math.min(available.bytes, 128 * 1024 * 1024),
    uploadPerFrame: Math.min(available.uploadPerFrame, 8 * 1024 * 1024),
  }
  return gpu
}

/** Register every source before compiling marks that join fields across datasets. */
export async function createView(
  canvas: Parameters<typeof View.create>[0],
  scene: Parameters<typeof View.create>[1],
  options: NonNullable<Parameters<typeof View.create>[2]>,
): Promise<View> {
  const view = await View.create(canvas, { ...scene, marks: [] }, options)
  try {
    view.scene = scene
    if (!options.camera) view.fit()
    return view
  } catch (error) {
    view.destroy()
    throw error
  }
}

window.addEventListener(
  'pagehide',
  () => {
    ended = true
    for (const worker of workers) worker.terminate()
    workers.clear()
    if (workerUrl) URL.revokeObjectURL(workerUrl)
  },
  { once: true },
)
