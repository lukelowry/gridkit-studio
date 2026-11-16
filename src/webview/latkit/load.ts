/** Loads latkit's WebAssembly and worker, and opens GPUs. */

import { Gpu, load } from 'latkit'

import { failedWith } from '../../shared/errors.js'

/** Set when the page reloads after latkit stopped; cleared once the page draws again. */
const STOPPED = 'gridkitStudio.stopped'

/** The URL of a bundled asset, from the page's `<meta name>`. */
export function asset(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
  if (!value) throw new Error(`Missing included asset: ${name}`)
  return value
}

/** Loads latkit once per page, retrying after a failure. The worker is on the webview's resource
 *  origin, so latkit fetches it through the page and starts it from a blob. */
export const loadLatkit = (): Promise<void> =>
  load({ wasm: asset('latkit-wasm'), worker: asset('latkit-worker') })

export async function openGpu(): Promise<Gpu> {
  await loadLatkit()
  return Gpu.create()
}

/** Reloads the page once after latkit stops on an internal error; returns whether it did. Stopping
 *  again before the page draws is reported like any other error. */
export function startOver(error: unknown): boolean {
  if (!failedWith(error, 'stopped')) return false
  try {
    if (sessionStorage.getItem(STOPPED)) return false
    sessionStorage.setItem(STOPPED, 'true')
  } catch {
    // Without storage, reload anyway.
  }
  location.reload()
  return true
}

/** Lets `startOver` reload again, once the page has drawn. */
export function clearStopped(): void {
  try {
    sessionStorage.removeItem(STOPPED)
  } catch {
    // Without storage, nothing was set.
  }
}
