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
import { contextKey } from '../../src/shared/ids.js'
import type { Run } from '../../src/shared/messages.js'
import { type Keys, type Manifest, Menus } from '../menus.js'
import { withMons } from '../mons.js'

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
      studio.files.changed.event,
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

/** The text of the file at `uri` as it is on disk. */
const textOf = (uri: vscode.Uri) => readFile(uri.fsPath, 'utf8')

/** IEEE39, the case every suite starts from, followed alone with its file as found. */
export class Bench {
  /** The case's file as found. */
  readonly text: string
  /** Its solver file as found. */
  readonly solverText: string
  /** That case, parsed. */
  readonly source: {
    buses: { number: number; name: string; params: { kv: number } }[]
    devices: { class: string; id: string; ports?: Record<string, number | string | null> }[]
  }
  /** Where the installed manifest places Studio's commands. */
  readonly menus: Menus

  private constructor(text: string, solver: string) {
    this.text = text
    this.solverText = solver
    this.source = JSON.parse(this.text)
    this.menus = new Menus(extension().packageJSON as Manifest)
  }

  static async start(): Promise<Bench> {
    const text = await textOf(vscode.Uri.joinPath(folder(), 'IEEE39.case.json'))
    await extension().activate()
    const solver = await textOf(vscode.Uri.joinPath(folder(), 'IEEE39.solver.json'))
    return new Bench(text, solver)
  }

  get studio(): Sessions {
    return extension().exports.studio
  }
  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(folder(), 'IEEE39.case.json')
  }
  get key(): string {
    return this.uri.toString()
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
  follow(uri = this.uri): Promise<Session> {
    return this.studio.open(uri.toString())
  }

  /** Wait until Studio reads the case at `uri` as its file holds it now. */
  async settled(uri = this.uri): Promise<void> {
    const key = uri.toString()
    const { fingerprint } = await this.studio.files.read(key)
    await until(() => {
      const state = this.studio.state(key)
      return !state.stale && state.summary?.fingerprint === fingerprint
    }, 'the case reads as its file')
  }

  /** Write `text` into the case file at `uri`, as another program saves it. */
  async write(text: string, uri = this.uri): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
  }

  /** Whether every element of `type` records `field` in the case `uri` as Studio last read it. */
  recorded(type: string, field: string, uri = this.uri): boolean {
    const summary = this.studio.state(uri.toString()).summary
    const count = summary?.recording.listed[type]?.[field] ?? 0
    return count > 0 && count === summary?.counts[type]
  }

  /** Make every element of `type` record `fields` and no other sampled field, and with `only`,
   *  every other element nothing: their `mon` lists written into the file at `uri` as a user
   *  writes them. Waits for Studio to read the case so. */
  async record(
    type: string,
    fields: readonly string[],
    uri = this.uri,
    only = false,
  ): Promise<void> {
    const key = uri.toString()
    const summary = await this.studio.files.read(key)
    const sampled = summary.definition.tables
      .find((table) => table.name === type)!
      .fields.filter((field) => field.kind === 'sampled')
      .map((field) => field.name)
    const listed = withMons(await textOf(uri), ({ type: of, mon }) =>
      of === type
        ? [...mon.filter((name) => !sampled.includes(name)), ...fields]
        : only
          ? []
          : undefined,
    )
    await this.write(listed, uri)
    await until(
      () =>
        sampled.every((field) => this.recorded(type, field, uri) === fields.includes(field)) &&
        !this.studio.state(key).stale,
      `${type} records ${fields.join(', ')}`,
    )
  }

  /** Make the case record `fields` of `type` and nothing else. */
  recordOnly(type: string, fields: readonly string[]): Promise<void> {
    return this.record(type, fields, this.uri, true)
  }

  /** Write the solver file beside the case, its members `solver`. */
  async writeSolver(solver: Solver): Promise<vscode.Uri> {
    const text = solverText('IEEE39', solver)
    await vscode.workspace.fs.writeFile(this.solver, new TextEncoder().encode(text))
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

  /** Back to IEEE39 alone and followed: its file and solver file as found, no editor open, nothing
   *  run, selected, mapped or plotted. */
  async reset(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const running = this.studio.get(this.key)
    if (running?.running) {
      running.stop()
      await until(() => !running.running, 'the run stops')
    }
    if ((await textOf(this.uri)) !== this.text) await this.write(this.text)
    if ((await textOf(this.solver)) !== this.solverText)
      await vscode.workspace.fs.writeFile(this.solver, new TextEncoder().encode(this.solverText))
    const session = await this.follow()
    await this.settled()
    session.select()
    session.setPlots([])
    for (const { table, field } of Object.values(session.bindings))
      session.bind({ table, field }, [])
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
