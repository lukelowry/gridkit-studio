/** Reports failures as notifications backed by the log. Views show state, never failures. */

import * as vscode from 'vscode'

import { defect, detail, message, quiet } from '../shared/errors.js'
import { commandId } from '../shared/ids.js'

interface Offer {
  readonly title: string
  readonly command: string
}
export const SHOW_OUTPUT: Offer = { title: 'Show Output', command: commandId('showOutput') }
export const SHOW_PROBLEMS: Offer = {
  title: 'Show Problems',
  command: 'workbench.actions.view.problems',
}

/** An error reported as `text`, with `offers` as its buttons. */
export const notice = (text: string, ...offers: Offer[]) =>
  Object.assign(new Error(text), { offers })

export const noCase = () => new Error('Open a GridKit case first.')

/** Marks `reason` as already shown by a diagnostic in Problems, so it is not reported again. */
export const diagnosed = <E extends Error>(reason: E) => Object.assign(reason, { diagnosed: true })
export const isDiagnosed = (reason: unknown) =>
  (reason as { diagnosed?: unknown } | null)?.diagnosed === true

/** How many logged errors a test can inspect. */
const KEPT_ERRORS = 100

export class Reporter implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('GridKit Studio', { log: true })
  /** Errors logged since the last check, so a test fails on errors that only reach the log. */
  readonly errors: string[] = []
  /** Errors already logged, so one reported twice (as a stopped worker's is) is logged once. */
  readonly #logged = new WeakSet<object>()
  readonly #reported = new WeakSet<object>()
  readonly #visibleMessages = new Set<string>()

  /** Logs `reason` as an error, unless a diagnostic already shows it. */
  error(reason: unknown) {
    if (isDiagnosed(reason)) return
    if (reason instanceof Object) {
      if (this.#logged.has(reason)) return
      this.#logged.add(reason)
    }
    // Defects and coded errors log their stack and detail; others log their message.
    const text =
      defect(reason) || !(reason instanceof Error) || (reason as { code?: string }).code
        ? detail(reason)
        : reason.message
    this.output.error(text)
    if (this.errors.push(text) > KEPT_ERRORS) this.errors.shift()
  }

  /** Logs `reason` and shows it as a notification. Quiet errors, diagnosed errors and messages
   *  already shown are skipped. A defect offers the log; a notice offers its own buttons. */
  report(reason: unknown) {
    if (quiet(reason) || isDiagnosed(reason)) return
    if (reason instanceof Object) {
      if (this.#reported.has(reason)) return
      this.#reported.add(reason)
    }
    this.error(reason)
    const text = message(reason)
    if (this.#visibleMessages.has(text)) return
    this.#visibleMessages.add(text)
    const offers =
      (reason as { offers?: Offer[] } | null)?.offers ?? (defect(reason) ? [SHOW_OUTPUT] : [])
    void vscode.window.showErrorMessage(text, ...offers.map(({ title }) => title)).then(
      (choice) => {
        this.#visibleMessages.delete(text)
        const offer = offers.find(({ title }) => title === choice)
        if (offer) void vscode.commands.executeCommand(offer.command)
      },
      () => this.#visibleMessages.delete(text),
    )
  }

  dispose() {
    this.output.dispose()
  }
}
