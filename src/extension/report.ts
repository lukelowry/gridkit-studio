/** The one place Studio says why something failed: a notification, and the log behind it. Views show
 *  state, never failures. */

import * as vscode from 'vscode'

import { defect, detail, message, quiet } from '../shared/errors.js'
import { commandId } from '../shared/ids.js'

/** A choice a notification offers: its label, and the command it runs. */
export interface Offer {
  readonly title: string
  readonly command: string
}
/** The log, where every failed run and every defect points. */
export const SHOW_OUTPUT: Offer = { title: 'Show Output', command: commandId('showOutput') }
/** Problems, where a case that cannot be read says why. */
export const SHOW_PROBLEMS: Offer = {
  title: 'Show Problems',
  command: 'workbench.actions.view.problems',
}

/** An error to report as `text`, offering `offers`. */
export const notice = (text: string, ...offers: Offer[]) =>
  Object.assign(new Error(text), { offers })

/** Why nothing can be done with no case open. */
export const noCase = () => new Error('Open a GridKit case first.')

/** `reason`, which a case's diagnostic in Problems says already: nothing says it again. */
export const diagnosed = <E extends Error>(reason: E) => Object.assign(reason, { diagnosed: true })
/** Whether a case's diagnostic in Problems says `reason` already. */
export const saidInProblems = (reason: unknown) =>
  (reason as { diagnosed?: unknown } | null)?.diagnosed === true

/** How many of the errors logged a test can look at. */
const KEPT_ERRORS = 100

export class Reporter implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('GridKit Studio', { log: true })
  /** The errors logged since the last look, so a test fails on one a user would see only in the
   *  log. */
  readonly errors: string[] = []
  /** The errors already logged, so one reported twice, as a stopped worker's is, shows once. */
  readonly #logged = new WeakSet<object>()
  /** The errors already reported, and the notifications on show, by their text. */
  readonly #reported = new WeakSet<object>()
  readonly #showing = new Set<string>()

  /** Logs `reason` as an error, unless a case's diagnostic already shows it. */
  error(reason: unknown) {
    if (saidInProblems(reason)) return
    if (reason instanceof Object) {
      if (this.#logged.has(reason)) return
      this.#logged.add(reason)
    }
    // A defect's stack is for whoever fixes it; anything else is said as it was told.
    const text =
      defect(reason) || !(reason instanceof Error) || (reason as { code?: string }).code
        ? detail(reason)
        : reason.message
    this.output.error(text)
    if (this.errors.push(text) > KEPT_ERRORS) this.errors.shift()
  }

  /** Tells the user why something failed. A defect points to the log, a notice offers its own
   *  choices, a failure that is none says nothing, a case's diagnostic in Problems says it already,
   *  and an error already on show is not shown again. */
  report(reason: unknown) {
    if (quiet(reason) || saidInProblems(reason)) return
    if (reason instanceof Object) {
      if (this.#reported.has(reason)) return
      this.#reported.add(reason)
    }
    this.error(reason)
    const text = message(reason)
    if (this.#showing.has(text)) return
    this.#showing.add(text)
    const offers =
      (reason as { offers?: Offer[] } | null)?.offers ?? (defect(reason) ? [SHOW_OUTPUT] : [])
    void vscode.window.showErrorMessage(text, ...offers.map(({ title }) => title)).then(
      (choice) => {
        this.#showing.delete(text)
        const offer = offers.find(({ title }) => title === choice)
        if (offer) void vscode.commands.executeCommand(offer.command)
      },
      () => this.#showing.delete(text),
    )
  }

  dispose() {
    this.output.dispose()
  }
}
