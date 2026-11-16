/** Drives Studio through its commands and exports; tests check Studio's state and messages, never
 *  what a window draws. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import { gridkitOf } from '../../src/extension/settings.js'
import type { Studio } from '../../src/extension/studio.js'
import { available } from '../../src/gridkit/index.js'
import { contextKey } from '../../src/shared/ids.js'
import type { Run } from '../../src/shared/messages.js'
import { type Keys, type Manifest, Menus } from '../menus.js'
import { withMons } from '../mons.js'

const WAIT = 10_000

/** Solver file members other than the case file. */
export type Solver = Record<string, unknown>

export const folder = () => vscode.workspace.workspaceFolders![0]!.uri

export function extension(): vscode.Extension<{ studio: Studio }> {
  const found = vscode.extensions.getExtension<{ studio: Studio }>('lukelowery.gridkit-studio')
  assert.ok(found, 'GridKit Studio must be installed and enabled')
  return found
}

/** Resolves with `check`'s first truthy result, evaluated now and on each Studio or VS Code change
 *  event. Rejects with `label` after `timeout`. */
export function until<T>(
  check: () => T | Promise<T>,
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
          const value = await check()
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
    // Poll for changes no event reports, such as a file another process writes.
    const fallback = setInterval(() => void ask(), 250)
    const timer = setTimeout(
      () =>
        end(() => reject(new Error('Timed out: ' + (typeof label === 'string' ? label : label())))),
      timeout,
    )
    void ask()
  })
}

/** A solver file for `name.case.json` that writes to `output/name.csv`. */
const solverText = (name: string, solver: Solver) =>
  JSON.stringify(
    { system_model_file: name + '.case.json', output_file: 'output/' + name + '.csv', ...solver },
    null,
    4,
  ) + '\n'

const textOf = (uri: vscode.Uri) => readFile(uri.fsPath, 'utf8')

/** IEEE39, the case every suite starts from, with its original files. The e2e suites extend it. */
export class Bench {
  /** The original case file. */
  readonly text: string
  /** The original solver file. */
  readonly solverText: string
  readonly source: {
    buses: { number: number; name: string; params: { kv: number } }[]
    devices: { class: string; id: string; ports?: Record<string, number | string | null> }[]
  }
  readonly menus: Menus

  protected constructor(text: string, solver: string) {
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

  get studio(): Studio {
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

  /** Removes and returns the errors Studio reported, so a test can expect them. */
  takeErrors(): string[] {
    return this.studio.reporter.errors.splice(0)
  }

  /** Makes the case active, as opening it does. */
  follow(uri = this.uri): Promise<Session> {
    return this.studio.open(uri.toString())
  }

  /** Waits until Studio has read the current contents of the case at `uri`. */
  async settled(uri = this.uri): Promise<void> {
    const key = uri.toString()
    const { fingerprint } = await this.studio.files.read(key)
    await until(() => {
      const state = this.studio.state(key)
      return !state.stale && state.summary?.fingerprint === fingerprint
    }, 'the case reads as its file')
  }

  async write(text: string, uri = this.uri): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
  }

  /** Rewrites the `mon` lists in the case file so every `type` element records exactly `fields`
   *  (and with `only`, nothing else records), then waits for Studio to read it. */
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
    // Fixture setup must not depend on the OS watcher having started or delivered an event.
    await until(
      async () => {
        const { recording, counts } = await this.studio.files.read(key)
        return (
          sampled.every(
            (field) =>
              (recording.listed[type]?.[field] ?? 0) ===
              (fields.includes(field) ? counts[type] : 0),
          ) &&
          (!only || Object.keys(recording.listed).every((of) => of === type)) &&
          !this.studio.state(key).stale
        )
      },
      `${type} records ${fields.join(', ')}`,
    )
  }

  recordOnly(type: string, fields: readonly string[]): Promise<void> {
    return this.record(type, fields, this.uri, true)
  }

  async writeSolver(solver: Solver, uri = this.uri): Promise<vscode.Uri> {
    const name = basename(uri.path).replace(/\.case\.json$/i, '')
    const file = vscode.Uri.joinPath(uri, '..', name + '.solver.json')
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(solverText(name, solver)))
    return file
  }

  /** Runs the solver file as its Explorer menu does and waits for the run to end. */
  async run(command = 'gridkitStudio.runSimulation', ...args: unknown[]): Promise<Run> {
    const before = this.studio.get(this.key)?.run?.id
    await vscode.commands.executeCommand(command, ...(args.length ? args : [this.solver]))
    const run = this.studio.get(this.key)?.run
    assert.ok(
      run && run.id !== before && run.state !== 'running',
      this.studio.reporter.errors.join('\n') || 'The command did not finish a new run',
    )
    return run
  }

  /** The first run after `before`, once it ends. */
  nextRun(before: string | undefined, timeout = 120_000): Promise<Run> {
    return until(
      () => {
        const run = this.studio.get(this.key)?.run
        return run && run.id !== before && run.state !== 'running' ? run : undefined
      },
      'the run ends',
      timeout,
    )
  }

  /** Runs `command` as a menu does, without waiting for it; failures go to Studio's reporter. */
  command(command: string, ...args: unknown[]): void {
    void vscode.commands
      .executeCommand(command, ...args)
      .then(undefined, (error: unknown) => this.studio.reporter.error(error))
  }

  keys(): Keys {
    return {
      ...Object.fromEntries(
        [...this.studio.contexts].map(([key, value]) => [contextKey(key), value]),
      ),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    }
  }

  /** Whether GridKit is available (bundled WASM or a native install); throws when
   *  GRIDKIT_TEST_REQUIRED is set and it is not. */
  async gridkit(): Promise<boolean> {
    const runtime = available(gridkitOf(this.uri))
    if (process.env.GRIDKIT_TEST_REQUIRED === '1') await runtime
    return runtime.then(
      () => true,
      () => false,
    )
  }

  async copy(path: string, name = basename(path)): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(folder(), name)
    await vscode.workspace.fs.writeFile(
      uri,
      await readFile(join(process.env.GRIDKIT_TEST_ROOT!, path)),
    )
    return uri
  }

  /** Restores IEEE39 as the only, active case, with nothing run, selected, mapped or plotted. */
  async reset(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await this.restore()
    const session = await this.follow()
    await this.settled()
    this.clean(session)
    // No Network is open, so the last framing no longer applies.
    session.setFraming(undefined)
    session.clear()
    this.takeErrors()
  }

  /** Stops any run and restores the original case and solver files. */
  protected async restore(): Promise<void> {
    const running = this.studio.get(this.key)
    if (running?.running) {
      running.stop()
      await until(() => !running.running, 'the run stops')
    }
    if ((await textOf(this.uri)) !== this.text) await this.write(this.text)
    if ((await textOf(this.solver)) !== this.solverText)
      await vscode.workspace.fs.writeFile(this.solver, new TextEncoder().encode(this.solverText))
  }

  /** Clears selection, mappings, monitor choices and table filters, and resets the playback rate.
   *  Framing is left to the Network, which reports it as it changes. */
  protected clean(session: Session): void {
    session.select()
    for (const { table, field } of session.monitors) session.setMonitor({ table, field })
    const [first] = session.monitors
    if (first) session.showMonitor(first)
    for (const { table, field } of Object.values(session.mappings))
      session.map({ table, field }, [])
    session.setTable({
      type: undefined,
      columns: undefined,
      order: undefined,
      filter: undefined,
      equal: undefined,
    })
    session.transport.setRate(1)
  }
}

let started: Promise<Bench> | undefined

/** The shared bench, reset so each suite starts from the same state. */
export async function bench(): Promise<Bench> {
  const host = await (started ??= Bench.start())
  await host.reset()
  return host
}

/** Logs the bench state after a test fails and stops any run it left going. */
export async function failed(): Promise<void> {
  const host = await started?.catch(() => undefined)
  if (!host) return
  const session = host.studio.get(host.key)
  console.error('Case state:', JSON.stringify(host.studio.state(host.key)).slice(0, 2000))
  console.error('Run:', JSON.stringify(session?.run))
  session?.stop()
}
