/** latkit in a page: its WebAssembly, shaders and worker, loaded once, and the GPU its views draw
 *  with. */

import { Gpu, load } from 'latkit'

import { failedWith } from '../../shared/errors.js'

let loading: Promise<void> | undefined
let worker: string | undefined

/** Whether this page started over after latkit stopped, and has not drawn since. */
const STOPPED = 'gridkitStudio.stopped'

/** The URL of the bundled asset the page's `name` meta names. */
export function asset(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
  if (!value) throw new Error(`Missing bundled asset: ${name}`)
  return value
}

/** Loads latkit once per page. A webview's own service worker serves its assets, and a worker
 *  fetching its script by URL would go around it, so the worker starts from the script's text,
 *  fetched while the WebAssembly compiles. Jobs start only once this resolves. */
export function loadLatkit(): Promise<void> {
  return (loading ??= (async () => {
    const [script] = await Promise.all([
      fetch(asset('latkit-worker')).then((response) => {
        if (!response.ok) throw new Error(`Could not load the Latkit worker (${response.status}).`)
        return response.text()
      }),
      load({
        wasm: asset('latkit-wasm'),
        shaders: asset('latkit-shaders'),
        worker: () => new Worker(worker!),
      }),
    ])
    worker = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }))
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  }))
}

export async function openGpu(): Promise<Gpu> {
  await loadLatkit()
  return Gpu.create()
}

/** Whether latkit stopped after an internal error, and the page starts over for it: once, until it
 *  draws again. Stopping again before then, the page stays, and the error is said like any other. */
export function startOver(error: unknown): boolean {
  if (!failedWith(error, 'stopped')) return false
  try {
    if (sessionStorage.getItem(STOPPED)) return false
    sessionStorage.setItem(STOPPED, 'true')
  } catch {
    // A page without storage cannot tell it started over before, and starts over.
  }
  location.reload()
  return true
}

/** The page drew: should latkit stop again, it starts over again. */
export function drew(): void {
  try {
    sessionStorage.removeItem(STOPPED)
  } catch {
    // Nothing was kept to forget.
  }
}
