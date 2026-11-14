/** What every page of latkit views keeps: whether VS Code shows it, the theme's version, and the GPU
 *  its views draw with, opened once the page is in sight and made anew as Reload View asks. */

import type { Gpu } from 'latkit'
import { tick, untrack } from 'svelte'

import { quiet } from '../../shared/errors.js'
import { bridge } from '../bridge.js'
import { openGpu, startOver } from './load.js'
import { watchTheme } from './theme.js'

export class LatkitPage {
  /** The GPU the page's views draw with, once open. */
  gpu = $state.raw<Gpu>()
  /** Whether VS Code shows the page. */
  visible = $state(true)
  /** Whether the window the page is in is hidden. */
  hidden = $state(document.hidden)
  /** Counts the theme's changes, which every scene of the page reads. */
  themeVersion = $state(0)
  /** Whether the page is in sight: its views draw only then. */
  readonly active = $derived(this.visible && !this.hidden)

  readonly #report: (error: unknown) => void
  readonly #stop: Array<() => unknown>
  #generation = 0
  #opening = false
  #closed = false

  /** A page whose failures `report` says, made as its component is. */
  constructor(report: (error: unknown) => void) {
    this.#report = report
    const visibility = () => (this.hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    this.#stop = [
      () => document.removeEventListener('visibilitychange', visibility),
      bridge.on((message) => {
        if (message.kind === 'shown') this.visible = message.shown
      }),
      watchTheme(() => this.themeVersion++),
    ]
    // A GPU that did not open is asked for again as the page comes back into sight.
    $effect(() => {
      if (this.active && !this.gpu) untrack(() => void (this.#opening || this.open()))
    })
  }

  /** Says `error`, unless it is no failure, or latkit stopped and the page starts over for it. */
  readonly fail = (error: unknown): void => {
    if (!quiet(error) && !startOver(error)) this.#report(error)
  }

  /** Opens a GPU in place of the one open, which goes once the views drawing with it have gone with
   *  the markup that shows them: as the page first comes into sight, and as Reload View asks. */
  async open(): Promise<void> {
    const generation = ++this.#generation
    this.#opening = true
    const previous = this.gpu
    this.gpu = undefined
    try {
      await tick()
      previous?.destroy()
      const made = await openGpu()
      if (this.#closed || generation !== this.#generation) return made.destroy()
      this.gpu = made
    } catch (error) {
      if (generation === this.#generation) this.fail(error)
    } finally {
      if (generation === this.#generation) this.#opening = false
    }
  }

  /** Lets go of everything the page holds, as it goes. */
  destroy(): void {
    this.#closed = true
    this.#generation++
    for (const stop of this.#stop) stop()
    this.gpu?.destroy()
  }
}
