/** GridKit Studio in the VS Code it runs in, driven through its commands and its exports: what a
 *  test checks is what Studio holds and says, never what a window draws. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import type { Sessions } from '../../src/extension/sessions.js'
import { gridkitOf } from '../../src/extension/settings.js'
import { available } from '../../src/gridkit/index.js'
import { menuContext, type Target } from '../../src/shared/contexts.js'
import { contextKey } from '../../src/shared/ids.js'
import type { Run } from '../../src/shared/messages.js'
import { type Keys, type Manifest, Menus } from '../menus.js'

/** How long a wait lasts before it fails: Studio answers a change in far less. */
const WAIT = 10_000

/** A solver file's members, besides the case it names. */
export type Solver = Record<string, unknown>

/** The test workspace folder, which holds the case. */
export const folder = () => vscode.workspace.workspaceFolders![0]!.uri

/** GridKit Studio as installed in this VS Code. */
export function extension(): vscode.Extension<{ studio: Sessions }> {
  const found = vscode.extensions.getExtension<{ studio: Sessions }>('lukelowery.gridkit-studio')
  assert.ok(found, 'GridKit Studio must be installed and enabled')
  return found
}

/** Resolves to what `holds` answers once it is truthy: asked now, and again at each change Studio
 *  or VS Code says it made. Fails after `timeout`, saying `label`. */
export function until<T>(
  holds: () => T | Promise<T>,
  label: string | (() => string),
  timeout = WAIT,
): Promise<NonNullable<T>> {
  const { studio } = extension().exports
  return new Promise((resolve, reject) => {
    let done = false
    let asking = false
    let again = false
    const end = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(fallback)
      for (const subscription of subscriptions) subscription.dispose()
      settle()
    }
    const ask = async () => {
      if (done) return
      if (asking) {
        again = true
        return
      }
      asking = true
      try {
        do {
          again = false
          const value = await holds()
          if (value) return end(() => resolve(value as NonNullable<T>))
        } while (again && !done)
      } catch (error) {
        end(() => reject(error))
      } finally {
        asking = false
      }
    }
    const subscriptions = [
      studio.changed.event,
      studio.clock.event,
      studio.documents.changed.event,
      vscode.workspace.onDidChangeTextDocument,
      vscode.workspace.onDidSaveTextDocument,
      vscode.languages.onDidChangeDiagnostics,
      vscode.window.tabGroups.onDidChangeTabs,
    ].map((event) => event(() => void ask()))
    // What no event announces, such as a file another process writes, is asked of now and then.
    const fallback = setInterval(() => void ask(), 250)
    const timer = setTimeout(
      () =>
        end(() => reject(new Error('Timed out: ' + (typeof label === 'string' ? label : label())))),
      timeout,
    )
    void ask()
  })
}

/** The solver file `name.solver.json` for the case `name.case.json` beside it: its own members,
 *  writing its samples to `output/name.csv`. */
const solverText = (name: string, solver: Solver) =>
  JSON.stringify(
    { system_model_file: name + '.case.json', output_file: 'output/' + name + '.csv', ...solver },
    null,
    4,
  ) + '\n'

/** IEEE39, the case every suite starts from, followed alone with its source as found. */
export class Bench {
  /** The case's source as found. */
  readonly text: string
  /** Its solver file as found. */
  readonly solverText: string
  /** That source, parsed. */
  readonly source: {
    buses: { number: number; name: string; params: { kv: number } }[]
    devices: { class: string; id: string; ports?: Record<string, number | string | null> }[]
  }
  /** Where the installed manifest places Studio's commands. */
  readonly menus: Menus
  #document: vscode.TextDocument

  private constructor(document: vscode.TextDocument, solver: string) {
    this.#document = document
    this.text = document.getText()
    this.solverText = solver
    this.source = JSON.parse(this.text)
    this.menus = new Menus(extension().packageJSON as Manifest)
  }

  static async start(): Promise<Bench> {
    const uri = vscode.Uri.joinPath(folder(), 'IEEE39.case.json')
    const document = await vscode.workspace.openTextDocument(uri)
    await extension().activate()
    const solver = await readFile(
      vscode.Uri.joinPath(folder(), 'IEEE39.solver.json').fsPath,
      'utf8',
    )
    return new Bench(document, solver)
  }

  get studio(): Sessions {
    return extension().exports.studio
  }
  get uri(): vscode.Uri {
    return this.#document.uri
  }
  get key(): string {
    return this.uri.toString()
  }
  /** The case's document as VS Code holds it now. One no editor showed for a while VS Code closes,
   *  and opens again as another. */
  get document(): vscode.TextDocument {
    this.#document =
      vscode.workspace.textDocuments.find((open) => open.uri.toString() === this.key) ??
      this.#document
    return this.#document
  }
  get session(): Session {
    const session = this.studio.get(this.key)
    assert.ok(session, 'IEEE39 is followed')
    return session
  }
  get solver(): vscode.Uri {
    return vscode.Uri.joinPath(folder(), 'IEEE39.solver.json')
  }

  /** What Studio said the user would see, taken so the test may expect it. */
  said(): string[] {
    return this.studio.reporter.errors.splice(0)
  }

  /** Follow the case, as opening it does. */
  async follow(uri = this.uri): Promise<Session> {
    return this.studio.open(await vscode.workspace.openTextDocument(uri))
  }

  /** Wait until the case Studio holds is the document's own revision. */
  settled(): Promise<unknown> {
    return until(() => {
      const state = this.studio.state(this.key)
      return state.summary?.version === this.document.version && !state.stale
    }, 'the case follows its document')
  }

  /** Replace the case's whole source, unsaved. */
  async replace(text: string, uri = this.uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), text)
    await vscode.workspace.applyEdit(edit)
  }

  /** Undo in the case's source with VS Code's own undo, until it reads as found. */
  async undo(): Promise<void> {
    await vscode.window.showTextDocument(this.document)
    await vscode.commands.executeCommand('undo')
    await until(() => this.document.getText() === this.text, 'the source as found')
    await this.settled()
  }

  /** Whether every element of `type` records `field` in the case `uri` as Studio last read it. */
  recorded(type: string, field: string, uri = this.uri): boolean {
    const summary = this.studio.state(uri.toString()).summary
    const count = summary?.recording.listed[type]?.[field] ?? 0
    return count > 0 && count === summary?.counts[type]
  }

  /** Make every element of `type` record `fields` and no other sampled field, as Monitored Signals
   *  does, and wait for the case to read so. */
  async record(type: string, fields: readonly string[], uri = this.uri): Promise<void> {
    const key = uri.toString()
    const summary = await this.studio.documents.ensure(await vscode.workspace.openTextDocument(uri))
    const sampled = summary.definition.tables
      .find((table) => table.name === type)!
      .fields.filter((field) => field.kind === 'sampled')
      .map((field) => field.name)
    await this.studio.documents.transact(
      key,
      summary.version,
      [{ kind: 'record', type, add: fields, remove: sampled.filter((f) => !fields.includes(f)) }],
      'Record ' + fields.join(', '),
    )
    await until(
      () =>
        sampled.every((field) => this.recorded(type, field, uri) === fields.includes(field)) &&
        !this.studio.state(key).stale,
      `${type} records ${fields.join(', ')}`,
    )
  }

  /** Make the case record `fields` of `type` and nothing else, as Record No Signals then a check
   *  in Monitored Signals do. */
  async recordOnly(type: string, fields: readonly string[]): Promise<void> {
    await vscode.commands.executeCommand('gridkitStudio.recordNoSignals')
    await until(
      () =>
        !Object.keys(this.studio.state(this.key).summary?.recording.listed ?? {}).length &&
        !this.studio.state(this.key).stale,
      'the case records nothing',
    )
    if (fields.length) await this.record(type, fields)
  }

  /** Write the solver file beside the case, its members `solver`. */
  async writeSolver(solver: Solver): Promise<vscode.Uri> {
    const text = solverText('IEEE39', solver)
    await vscode.workspace.fs.writeFile(this.solver, new TextEncoder().encode(text))
    await until(
      async () => (await vscode.workspace.openTextDocument(this.solver)).getText() === text,
      'the solver file read again',
    )
    return this.solver
  }

  /** Run the solver file as its Explorer menu does, and wait for the run to end. */
  async run(command = 'gridkitStudio.runSimulation', ...args: unknown[]): Promise<Run> {
    const before = this.studio.get(this.key)?.run?.id
    this.command(command, ...(args.length ? args : [this.solver]))
    return this.ran(before)
  }

  /** The run after the one `before` names, once it ends. */
  ran(before: string | undefined, timeout = 120_000): Promise<Run> {
    return until(
      () => {
        const run = this.studio.get(this.key)?.run
        return run && run.id !== before && run.state !== 'running' ? run : undefined
      },
      'the run ends',
      timeout,
    )
  }

  /** Run `command` as VS Code does from a menu, without waiting on it: one that asks something
   *  waits for its answer. Its failure is said as Studio says any. */
  command(command: string, ...args: unknown[]): void {
    void vscode.commands
      .executeCommand(command, ...args)
      .then(undefined, (error: unknown) => this.studio.reporter.error(error))
  }

  /** The context keys VS Code holds for title bars and the Command Palette. */
  keys(): Keys {
    return {
      ...Object.fromEntries(
        [...this.studio.contexts].map(([key, value]) => [contextKey(key), value]),
      ),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    }
  }

  /** Choose `item` from the menu a right-click on `target` opens in its view: the context its page
   *  gives the click, matched against the manifest as VS Code matches it, and its command run with
   *  that context as VS Code runs it. Where a view draws the target is its page's and latkit's. */
  async menu(target: Omit<Target, 'uri' | 'version'>, item: string): Promise<void> {
    const state = this.studio.state(this.key)
    assert.ok(state.summary, 'the case reads')
    const context = menuContext(
      state.summary,
      { uri: this.key, version: state.summary.version, ...target },
      state.bindings,
    )
    const { command } = this.menus.find('webview/context', item, context)
    assert.ok(this.menus.enabled(command, { ...this.keys(), ...context }), item + ' enabled')
    await vscode.commands.executeCommand(command, {
      ...context,
      webview: 'gridkitStudio.' + target.origin,
    })
  }

  /** Whether GridKit runs here: installed, or its image on this machine. A required run fails
   *  without it. */
  async gridkit(): Promise<boolean> {
    const runtime = available(gridkitOf(this.uri))
    if (process.env.GRIDKIT_TEST_REQUIRED === '1') await runtime
    return runtime.then(
      () => true,
      () => false,
    )
  }

  /** Copy a case of the repository's into the workspace, named `name`, and follow it. */
  async copy(path: string, name = basename(path)): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(folder(), name)
    await vscode.workspace.fs.writeFile(
      uri,
      await readFile(join(process.env.GRIDKIT_TEST_ROOT!, path)),
    )
    return uri
  }

  /** Back to IEEE39 alone and followed: its source and solver file as found and saved, no editor
   *  open, nothing run, selected, mapped or plotted. */
  async reset(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const running = this.studio.get(this.key)
    if (running?.running) {
      running.stop()
      await until(() => !running.running, 'the run stops')
    }
    if (this.document.getText() !== this.text) await this.replace(this.text)
    if (this.document.isDirty) await this.document.save()
    const solver = await vscode.workspace.openTextDocument(this.solver)
    if (solver.getText() !== this.solverText) await this.writeSolver(JSON.parse(this.solverText))
    const session = await this.follow()
    await this.settled()
    session.select()
    session.setPlots([])
    for (const { table, field } of Object.values(session.bindings))
      session.bind({ table, field }, [])
    session.setEditing(false)
    session.setFraming('network', undefined)
    session.setFraming('diagram', undefined)
    session.setTable({
      type: undefined,
      columns: undefined,
      order: undefined,
      filter: undefined,
      equal: undefined,
    })
    session.clear()
    session.transport.setRate(1)
    this.said()
  }
}

let started: Promise<Bench> | undefined

/** The one bench, reset: every suite starts from IEEE39 alone, so each runs alone as it does
 *  among the others. */
export async function bench(): Promise<Bench> {
  const host = await (started ??= Bench.start())
  await host.reset()
  return host
}

/** What the bench holds when a test fails, and a run it left going stopped. */
export async function failed(): Promise<void> {
  const host = await started?.catch(() => undefined)
  if (!host) return
  const session = host.studio.get(host.key)
  console.error('Case state:', JSON.stringify(host.studio.state(host.key)).slice(0, 2000))
  console.error('Run:', JSON.stringify(session?.run))
  session?.stop()
}
