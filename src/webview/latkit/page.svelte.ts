/** Per-page latkit state: visibility, the theme version, and the GPU. */

import type { Gpu, View } from 'latkit'
import { tick, untrack } from 'svelte'

import { quiet } from '../../shared/errors.js'
import { bridge } from '../bridge.js'
import { openGpu, startOver } from './load.js'
import { watchTheme } from './theme.js'

export class LatkitPage {
  gpu = $state.raw<Gpu>()
  visible = $state(true)
  hidden = $state(document.hidden)
  /** Incremented on each theme change; every scene of the page reads it. */
  themeVersion = $state(0)
  readonly active = $derived(this.visible && !this.hidden)

  readonly #report: (error: unknown) => void
  readonly #cleanup: Array<() => unknown>
  #generation = 0
  #opening = false
  #closed = false
  #unfollow?: () => void

  /** Construct during component initialization, since it creates an effect. */
  constructor(report: (error: unknown) => void) {
    this.#report = report
    const visibility = () => (this.hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    this.#cleanup = [
      () => document.removeEventListener('visibilitychange', visibility),
      bridge.on((message) => {
        if (message.kind === 'visible') this.visible = message.visible
      }),
      watchTheme(() => this.themeVersion++),
    ]
    // Retry a GPU that failed to open whenever the page becomes visible.
    $effect(() => {
      if (this.active && !this.gpu) untrack(() => void (this.#opening || this.open()))
    })
  }

  /** Reports `error`, unless it is quiet or the page reloads for it. */
  readonly fail = (error: unknown): void => {
    if (!quiet(error) && !startOver(error)) this.#report(error)
  }

  /** Replaces the GPU. The old one is destroyed after a tick, once the views using it unmount. */
  async open(): Promise<void> {
    const generation = ++this.#generation
    this.#opening = true
    const previous = this.gpu
    this.gpu = undefined
    try {
      await tick()
      previous?.destroy()
      const opened = await openGpu()
      if (this.#closed || generation !== this.#generation) return opened.destroy()
      this.gpu = opened
    } catch (error) {
      if (generation === this.#generation) this.fail(error)
    } finally {
      if (generation === this.#generation) this.#opening = false
    }
  }

  /** While `playing` and active, sets `views()` to `now()` on every GPU frame. Call again whenever
   *  any of these may have changed. */
  follow(playing: boolean, views: () => Iterable<View>, now: () => number): void {
    this.#unfollow?.()
    this.#unfollow = undefined
    const { gpu } = this
    if (!gpu || !this.active || !playing) return
    this.#unfollow = gpu.on('frame', () => {
      const at = now()
      for (const view of views()) view.at = at
    })
  }

  destroy(): void {
    this.#closed = true
    this.#generation++
    this.#unfollow?.()
    for (const cleanup of this.#cleanup) cleanup()
    this.gpu?.destroy()
  }
}
