/** latkit in a page: its WebAssembly and worker, and the GPU its views draw with. */

import { Gpu, load } from 'latkit'

import { failedWith } from '../../shared/errors.js'

/** Whether this page started over after latkit stopped, and has not drawn since. */
const STOPPED = 'gridkitStudio.stopped'

/** The URL of the bundled asset the page's `name` meta names. */
export function asset(name: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
  if (!value) throw new Error(`Missing bundled asset: ${name}`)
  return value
}

/** Loads latkit. latkit loads once per page, shares that load, and tries a failed one again. The
 *  worker sits on the webview's resource origin, so latkit fetches it through the page and starts
 *  it from a blob. Jobs start only once this resolves. */
export const loadLatkit = (): Promise<void> =>
  load({ wasm: asset('latkit-wasm'), worker: asset('latkit-worker') })

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
