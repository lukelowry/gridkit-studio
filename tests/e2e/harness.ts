/** The VS Code under test: the extension and a case, driven from inside through the extension's
 *  exports and from outside by Playwright over the window's DevTools port. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { type Browser, chromium, type Frame, type Locator, type Page } from 'playwright-core'
import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import type { Sessions } from '../../src/extension/sessions.js'
import { gridkitOf } from '../../src/extension/settings.js'
import { available } from '../../src/gridkit/index.js'
import { contextKey } from '../../src/shared/ids.js'
import type { Results, ViewKind } from '../../src/shared/messages.js'
import { type Keys, type Manifest, Menus } from '../menus.js'
import { withMons } from '../mons.js'

const TIMEOUT = 30_000
/** How long a read of what the page shows now waits for it: a moment, not a timeout. */
const READ = { timeout: 1000 }
/** The results file the suites play: a second of every bus's voltage. */
const SYNTHETIC = 'Synthetic waveform.csv'

/** The title bars `title` runs commands from: a panel or side bar view's, or the custom editor's
 *  in front. */
export type TitleBar = 'case' | 'monitor' | 'signals' | 'export' | 'editor'

/** A solver file's members, besides the case it names. */
export type Solver = Record<string, unknown>

/** The solver file `name.solver.json` for the case `name.case.json` beside it: its own members,
 *  writing its samples to `output/name.csv`, as the samples' solver files do. */
export const solverText = (name: string, solver: Solver) =>
  JSON.stringify(
    { system_model_file: name + '.case.json', output_file: 'output/' + name + '.csv', ...solver },
    null,
    4,
  ) + '\n'

/** The window size every suite starts from. */
export const VIEWPORT = { width: 1600, height: 1000 }

/** A bus's recorded voltage magnitude: the signal the suites map, plot and play. */
export const VM = { table: 'Bus', field: 'Vm' } as const

/** Wait until `get` answers something truthy, and return it. A `label` that is a function says,
 *  once the wait fails, what it found instead. */
export async function until<T>(
  get: () => Promise<T> | T,
  label: string | (() => Promise<string> | string),
  timeout = TIMEOUT,
): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await get()
    if (value) return value as NonNullable<T>
    await pause(100)
  }
  throw new Error('Timed out: ' + (typeof label === 'string' ? label : await label()))
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Do `act` until `done` holds. VS Code drops an input it gets while busy, as a right-click that
 *  opens no menu, or a click on a menu or a box that does not take: once the act has had `settle`
 *  milliseconds to take effect and has not, it is done again. */
export async function again(
  act: () => Promise<unknown>,
  done: () => Promise<boolean> | boolean,
  label: string | (() => Promise<string> | string),
  timeout = TIMEOUT,
  settle = 2000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await act()
    const acted = Date.now()
    while (Date.now() - acted < settle) {
      if (await done()) return
      await pause(100)
    }
  }
  throw new Error('Timed out: ' + (typeof label === 'string' ? label : await label()))
}

/** Wait for `selector` to show in `frame`. One that never shows says what the page held. */
export async function visible(frame: Frame, selector: string): Promise<void> {
  try {
    await frame.locator(selector).first().waitFor({ state: 'visible', timeout: TIMEOUT })
  } catch (error) {
    throw new Error(`${selector} never showed. The page held ${await held(frame)}`, {
      cause: error,
    })
  }
}

/** A page's text, and each canvas's size and whether it drew. */
const held = (frame: Frame) =>
  frame
    .evaluate<string>(
      `JSON.stringify({
        text: document.body.innerText.slice(0, 200),
        hidden: document.hidden,
        canvases: Array.from(document.querySelectorAll('canvas'), (canvas) => ({
          rendered: canvas.dataset.rendered === 'true',
          size: [canvas.clientWidth, canvas.clientHeight],
        })),
      })`,
    )
    .catch((error: unknown) => `nothing readable (${String(error)})`)

/** A canvas view's counters, as `gridkitStats()` reports them. */
export const stats = <T extends { frames: number } = { frames: number }>(frame: Frame) =>
  frame.evaluate<T>('gridkitStats()')

/** How many frames a canvas view has drawn. */
export const frames = (frame: Frame) => frame.evaluate<number>('gridkitStats().frames')

/** Wait for a canvas view to stop drawing, and return its counters. One that draws on says so. */
export async function idle<T extends { frames: number } = { frames: number }>(
  frame: Frame,
): Promise<T> {
  let last = await stats<T>(frame)
  let now = last
  await until(
    async () => {
      await pause(250)
      ;[last, now] = [now, await stats<T>(frame)]
      return now.frames === last.frames
    },
    () => `the view still drawing, at ${now.frames} frames`,
  )
  return now
}

/** Plays `session`'s results over and over once played, for a test that measures playing for
 *  longer than they last: each time playback stops at their end, it starts again from their start.
 *  Dispose of what it returns to stop. */
export function replaying(studio: Sessions, session: Session): vscode.Disposable {
  const { transport } = session
  return studio.clock.event((uri) => {
    const { status, t, span } = transport.state
    if (uri === session.uri && status === 'paused' && t >= span[1]) transport.play()
  })
}

/** Whether a canvas view's canvas fills its webview edge to edge, with no padding around it. */
export const fills = (frame: Frame) =>
  frame.evaluate<boolean>(`(() => {
  const r = document.querySelector('canvas').getBoundingClientRect()
  return [r.x, r.y, r.width - innerWidth, r.height - innerHeight].every((v) => Math.abs(v) < 1) &&
    getComputedStyle(document.body).padding === '0px'
})()`)

/** VS Code's own file dialog, which a test can type a path into; `undefined` restores the OS's. */
export const simpleDialog = (on: true | undefined) =>
  vscode.workspace
    .getConfiguration()
    .update('files.simpleDialog.enable', on, vscode.ConfigurationTarget.Global)

/** The test workspace folder, which holds the case. */
export const folder = () => vscode.workspace.workspaceFolders![0]!.uri

/** GridKit Studio as installed in this VS Code. */
export function extension(): vscode.Extension<{ studio: Sessions }> {
  const found = vscode.extensions.getExtension<{ studio: Sessions }>('lukelowery.gridkit-studio')
  assert.ok(found, 'GridKit Studio must be installed and enabled')
  return found
}

/** Playwright on the VS Code window the tests run in. */
async function attach(): Promise<{ browser: Browser; page: Page }> {
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const page = browser.contexts().flatMap((context) => context.pages())[0]!
  await page.setViewportSize(VIEWPORT)
  return { browser, page }
}

/** The command that shows each panel view; the extension's own commands take the case. */
const PANELS = {
  case: 'gridkitStudio.openCasePanel',
  monitor: 'gridkitStudio.openMonitor',
  export: 'gridkitStudio.exportVideo',
} as const

export class TestHost {
  /** The case's file as the suites found it, and as each suite starts. */
  readonly text: string
  /** The solver file beside the case, as the suites found it, and as each suite starts. */
  readonly solverText: string
  /** That case, parsed. */
  readonly source: {
    buses: { number: number; name: string; params: { kv: number } }[]
    devices: { class: string; id: string }[]
  }
  /** What the run measured, written beside the screenshots when it ends. */
  readonly report: Record<string, unknown>
  /** Errors Studio's own pages threw. */
  readonly errors: string[] = []
  /** Errors VS Code's own code threw in its pages, kept in the report: VS Code's to fix. */
  readonly vscodeErrors: string[] = []
  /** Where the installed manifest places Studio's commands. */
  readonly menus: Menus

  private constructor(
    readonly extension: vscode.Extension<{ studio: Sessions }>,
    readonly browser: Browser,
    /** The VS Code window. */
    readonly page: Page,
    text: string,
    /** Where screenshots and the report are written. */
    readonly output: string,
    solver: string,
  ) {
    this.text = text
    this.solverText = solver
    this.source = JSON.parse(this.text)
    this.report = {
      vscodeVersion: vscode.version,
      extensionVersion: extension.packageJSON.version,
      latkit: extension.packageJSON.dependencies,
    }
    this.menus = new Menus(extension.packageJSON as Manifest)
    page.on('pageerror', (error) => {
      const text = error.stack ?? error.message
      // Studio's pages run its own bundles; anything else threw in VS Code's code.
      ;(/[\\/]dist[\\/]webview[\\/]/.test(text) ? this.errors : this.vscodeErrors).push(text)
    })
  }

  static async start(): Promise<TestHost> {
    const installed = extension()
    const uri = vscode.Uri.joinPath(folder(), 'IEEE39.case.json')
    const started = performance.now()
    // Opening a case is what activates the extension; nothing here calls activate().
    await vscode.commands.executeCommand('vscode.open', uri)
    await until(() => installed.isActive, 'a case opening activates the extension')
    const openCaseMs = performance.now() - started
    const { browser, page } = await attach()
    // Playwright sees only the frames that attach once it connects, so the views open after it.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const output = process.env.GRIDKIT_TEST_OUTPUT!
    await mkdir(join(output, 'playwright'), { recursive: true })
    await mkdir(join(output, 'tests'), { recursive: true })
    const text = await readFile(uri.fsPath, 'utf8')
    const solver = await readFile(
      vscode.Uri.joinPath(folder(), 'IEEE39.solver.json').fsPath,
      'utf8',
    )
    const bench = new TestHost(installed, browser, page, text, output, solver)
    bench.report.openCaseMs = openCaseMs
    return bench
  }

  get studio(): Sessions {
    return this.extension.exports.studio
  }
  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(folder(), 'IEEE39.case.json')
  }
  /** The case's key among the sessions. */
  get key(): string {
    return this.uri.toString()
  }
  get session() {
    return this.studio.get(this.key)!
  }
  /** The solver file beside the case, which runs it. */
  get solver(): vscode.Uri {
    return vscode.Uri.joinPath(folder(), 'IEEE39.solver.json')
  }

  /** Every frame of every VS Code page, webviews' included. */
  #frames(): Frame[] {
    return this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .flatMap((page) => page.frames())
  }

  /** The webview showing `kind`. */
  view(kind: ViewKind, uri?: string): Promise<Frame> {
    return until(async () => {
      for (const candidate of this.#frames())
        if (
          await candidate
            .locator('body[data-kind="' + kind + '"]:not([data-shown="false"])')
            .isVisible()
            .catch(() => false)
        )
          if (!uri || (await candidate.evaluate<string>('document.body.dataset.uri')) === uri)
            return candidate
    }, kind + ' webview')
  }

  /** Show the case in the Network, and wait for its first frame. */
  async open(column = vscode.ViewColumn.One): Promise<Frame> {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      this.uri,
      'gridkitStudio.network',
      column,
    )
    const frame = await this.view('network', this.uri.toString())
    await visible(frame, 'canvas[data-rendered=true]')
    return frame
  }

  /** Copy a case, named by its path from the repository root or in full, into the workspace and
   *  show it alone in Network, so that the only network webview is this case's. */
  async openCase(path: string): Promise<{ uri: vscode.Uri; network: Frame }> {
    const name = basename(path)
    const uri = vscode.Uri.joinPath(folder(), name)
    await copyFile(isAbsolute(path) ? path : join(process.env.GRIDKIT_TEST_ROOT!, path), uri.fsPath)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
    const network = await this.view('network')
    await visible(network, 'canvas[data-rendered=true]')
    await until(() => this.studio.files.get(uri.toString())?.summary, name + ' read')
    return { uri, network }
  }

  /** Show one of the case's panel views. */
  async show(kind: keyof typeof PANELS): Promise<Frame> {
    await vscode.commands.executeCommand(PANELS[kind], this.uri)
    return this.view(kind)
  }

  /** Whether every element of `type` lists `field` in the case `uri` as the worker last read it. */
  recorded(type: string, field: string, uri = this.uri): boolean {
    const summary = this.studio.state(uri.toString()).summary
    const count = summary?.recording.listed[type]?.[field] ?? 0
    return count > 0 && count === summary?.counts[type]
  }

  /** Make every element of `type` in the case `uri` list `fields` among its outputs and no other,
   *  their `mon` lists written into its file as a user writes them, and wait for the case to read
   *  so. */
  async record(type: string, fields: readonly string[], uri = this.uri): Promise<void> {
    const key = uri.toString()
    const summary = await this.studio.files.read(key)
    const sampled = summary.definition.tables
      .find((table) => table.name === type)!
      .fields.filter((field) => field.kind === 'sampled')
      .map((field) => field.name)
    const listed = withMons(await readFile(uri.fsPath, 'utf8'), ({ type: of, mon }) =>
      of === type ? [...mon.filter((name) => !sampled.includes(name)), ...fields] : undefined,
    )
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(listed))
    await until(
      () =>
        sampled.every((field) => this.recorded(type, field, uri) === fields.includes(field)) &&
        !this.studio.state(key).stale,
      `${type} records ${fields.join(', ')}`,
    )
  }

  /** Write the solver file beside the case `uri`, its members `solver`. */
  async writeSolver(solver: Solver, uri = this.uri): Promise<vscode.Uri> {
    const name = basename(uri.path).replace(/\.case\.json$/i, '')
    const file = vscode.Uri.joinPath(uri, '..', name + '.solver.json')
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(solverText(name, solver)))
    return file
  }

  /** A playback item of the status bar by the start of its name: Previous sample, Play, Pause,
   *  Replay, Next sample, Time, Speed, Go to end or Go live. */
  playback(name: string): Locator {
    return this.page
      .locator('.part.statusbar')
      .getByRole('button', { name: new RegExp('^' + name) })
  }

  // ── Commands, from where the user finds them ──
  //
  // The manifest decides what each title bar and menu offers, and the command runs with what
  // VS Code passes it there, without waiting on a popup VS Code may drop.

  /** The context keys VS Code holds for title bars and the Command Palette: Studio's own, and the
   *  workspace's trust. */
  keys(): Keys {
    return {
      ...Object.fromEntries(
        [...this.studio.contexts].map(([key, value]) => [contextKey(key), value]),
      ),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    }
  }

  /** Choose `item` from the title bar of `where`, its More Actions included, once it is offered
   *  there and enabled. */
  async title(where: TitleBar, item: string): Promise<void> {
    const editor = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const place = where === 'editor' ? 'editor/title' : 'view/title'
    const keys = () => {
      const active = editor()
      return {
        ...this.keys(),
        ...(where === 'editor'
          ? { activeCustomEditorId: active instanceof vscode.TabInputCustom ? active.viewType : '' }
          : { view: 'gridkitStudio.' + where }),
      }
    }
    const find = () => this.menus.find(place, item, keys())
    const { command } = await until(
      () => {
        try {
          const found = find()
          return this.menus.enabled(found.command, keys()) ? found : undefined
        } catch {
          return undefined
        }
      },
      () => {
        try {
          return `${find().title} enabled`
        } catch (error) {
          return (error as Error).message
        }
      },
    )
    // An editor's title bar gives its command the editor's file; a view's gives nothing.
    if (where === 'editor') this.#run(command, (editor() as vscode.TabInputCustom).uri)
    else this.#run(command)
  }

  /** Run the solver file `solver` from its Explorer menu, as `item` names the program: what a user
   *  does to run GridKit. What keeps a run from starting is said in a notification. */
  run(item = 'Run Dynamic Simulation', solver = this.solver): void {
    this.explorer(solver, item)
  }

  /** Choose `item` from the Explorer's menu on the file `uri`. */
  explorer(uri: vscode.Uri, item: string): void {
    const keys = { ...this.keys(), resourceFilename: basename(uri.path) }
    const { command } = this.menus.find('explorer/context', item, keys)
    this.#run(command, uri, [uri])
  }

  /** Run `command` as VS Code does from a menu: without waiting on it, as one that asks something
   *  waits for its answer. A command's failure is reported, which fails the test. */
  #run(command: string, ...args: unknown[]): void {
    void vscode.commands
      .executeCommand(command, ...args)
      .then(undefined, (error: unknown) => this.studio.reporter.error(error))
  }

  // ── VS Code's own prompts, answered from the keyboard ──

  /** The quick input on show: a quick pick, an input box, or a file dialog. One closed stays in the
   *  page hidden, holding what it last asked. What it says is read with `READ`, as one may close
   *  between two reads, and a read would otherwise wait out the whole timeout for another. */
  #prompt() {
    const widget = this.page.locator('.quick-input-widget:visible')
    return { widget, input: widget.locator('.quick-input-box input').first() }
  }

  /** The title of the prompt on show, which says what it asks. */
  async #asked(): Promise<string> {
    const { widget, input } = this.#prompt()
    await input.waitFor({ state: 'visible' })
    return widget
      .locator('.quick-input-title')
      .innerText(READ)
      .catch(() => '')
  }

  /** Press Enter on the prompt that asked `asked` until it takes `entered`: it closes, or asks
   *  something else. One that still asks it with the same text has not taken it, so Enter only
   *  ever reaches the prompt. */
  async #take(asked: string, entered: string): Promise<void> {
    const { widget, input } = this.#prompt()
    const asking = async () =>
      (await widget.isVisible()) &&
      (await widget
        .locator('.quick-input-title')
        .innerText(READ)
        .catch(() => '')) === asked &&
      (await input.inputValue(READ).catch(() => '')) === entered
    await again(
      async () => {
        if (await asking()) await input.press('Enter', { timeout: 2000 }).catch(() => {})
      },
      async () => !(await asking()),
      'the prompt takes ' + (entered || 'the answer'),
    )
  }

  /** Answer the file dialog on show, VS Code's own, with `path`. */
  async dialog(path: string): Promise<void> {
    const { input } = this.#prompt()
    // The dialog opens on the folder it starts in; a picker still closing holds other text.
    await until(
      async () => /[\\/]/.test(await input.inputValue(READ).catch(() => '')),
      'the file dialog',
    )
    const asked = await this.#asked()
    await input.fill(path)
    await this.#take(asked, path)
  }

  /** Save a picture of the whole VS Code window. */
  async capture(name: string): Promise<void> {
    await vscode.commands.executeCommand('notifications.clearAll')
    await pause(300)
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
  }

  /** Wait until the views' case reads as its file holds it now. */
  async settled(): Promise<void> {
    const { fingerprint } = await this.studio.files.read(this.key)
    await until(() => {
      const state = this.studio.state(this.key)
      return !state.stale && state.summary?.fingerprint === fingerprint
    }, 'the case reads as its file')
  }

  /** Results to play: a second of every bus's voltage, each a little out of step with the last,
   *  shown with the first bus's plotted. Those on show, or, once others took their place, the file
   *  read anew. */
  async results(): Promise<Results> {
    const shown = this.session.results
    if (shown?.name === SYNTHETIC && !shown.growing) return shown
    const results = await this.waveform(SYNTHETIC, 100, 1)
    this.plot()
    return results
  }

  /** Results of `frames` frames over `seconds`, every bus's voltage a little out of step with the
   *  last, written beside the case as `name` and shown once they are read; with `digits`, values
   *  are written to that many decimals, which keeps a long run's file small. */
  async waveform(name: string, frames: number, seconds: number, digits?: number): Promise<Results> {
    const csv = vscode.Uri.joinPath(this.uri, '..', name)
    const { buses } = this.source
    const voltage = (i: number, k: number) => {
      const value = 1 + 0.1 * Math.sin(i / 10 + k)
      return digits === undefined ? value : value.toFixed(digits)
    }
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(
        ['time', ...buses.map((bus) => 'Bus_' + bus.name + '_Vm')] +
          '\n' +
          Array.from(
            { length: frames },
            (_, i) => [(i * seconds) / frames, ...buses.map((_, k) => voltage(i, k))] + '\n',
          ).join(''),
      ),
    )
    await this.session.load(csv.fsPath)
    await until(
      () => this.session.results?.path === csv.fsPath && !this.session.results.growing,
      name + ' read',
    )
    return this.session.results!
  }

  /** Plot the first bus's voltage in the Monitor. */
  plot(): void {
    this.session.setPlots([{ from: VM.table, field: VM.field, id: this.source.buses[0]!.number }])
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

  /** Which GridKit the runs use: the image's ID, which stays the same however its tags move, or the
   *  installed program. Runs on different builds time different simulations. */
  async gridkitBuild(): Promise<string> {
    const runtime = await available(gridkitOf(this.uri))
    if (runtime.kind === 'installed') return runtime.program
    return new Promise((resolve, reject) =>
      execFile(
        runtime.cli,
        ['image', 'inspect', '--format', '{{.Id}}', runtime.image],
        { windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      ),
    )
  }

  /** Back to the case alone in its Network editor: its file as found, nothing selected or mapped,
   *  its clock at rest. */
  async reset(): Promise<void> {
    // A prompt a test left asking holds its command open, and would take the next one's keys.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    // A run under way is stopped.
    if (this.session?.running) {
      this.session.stop()
      await until(() => !this.session.running, 'the run stops')
    }
    if ((await readFile(this.uri.fsPath, 'utf8')) !== this.text)
      await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(this.text))
    if ((await readFile(this.solver.fsPath, 'utf8')) !== this.solverText)
      await vscode.workspace.fs.writeFile(this.solver, new TextEncoder().encode(this.solverText))
    await this.open()
    await this.settled()
    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups')
    await vscode.commands.executeCommand('workbench.action.closeOtherEditors')
    const { session } = this
    session.select()
    session.setPlots([])
    for (const { table, field } of Object.values(session.bindings))
      session.bind({ table, field }, [])
    session.setFraming(undefined)
    session.setTable({
      type: undefined,
      columns: undefined,
      order: undefined,
      filter: undefined,
      equal: undefined,
    })
    session.show(undefined)
    session.transport.setRate(1)
  }

  /** Keep what every view showed when `test` failed, with the files of its results. */
  async failed(test: string): Promise<void> {
    for (const frame of this.#frames())
      console.error(
        'View lifecycle:',
        await frame
          .evaluate("typeof gridkitLifecycle === 'function' ? gridkitLifecycle() : null")
          .catch(() => null),
      )
    console.error('Page errors:', this.errors)
    console.error('Studio failures:', this.studio.reporter.errors)
    console.error('Case state:', JSON.stringify(this.studio.state(this.key)).slice(0, 2000))
    // A run the test left going would slow every test after it.
    this.session?.stop()
    const name = 'failure-' + test.replace(/[^\w]+/g, '-').toLowerCase()
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
    const { run, results } = this.session ?? {}
    if (run || results) {
      const directory = join(this.output, 'tests', name, results?.id ?? run!.id)
      await mkdir(directory, { recursive: true })
      for (const file of [results?.path, this.uri.fsPath, this.solver.fsPath])
        if (file) await cp(file, join(directory, basename(file))).catch(() => {})
      await writeFile(join(directory, 'run.json'), JSON.stringify({ run, results }, null, 2))
    }
    for (const frame of this.#frames()) {
      const text = await frame
        .locator('main')
        .innerText({ timeout: 300 })
        .catch(() => '')
      if (text) console.log(text.slice(0, 1200))
    }
  }

  /** Write the report and let go of the window; a page that threw fails the run. */
  async finish(): Promise<void> {
    try {
      this.report.worker = await this.studio.client.stats()
      this.report.studioErrors = [...this.studio.reporter.errors]
      this.report.pageErrors = this.errors
      this.report.vscodeErrors = this.vscodeErrors
      await writeFile(
        join(this.output, 'tests', 'vscode-report.json'),
        JSON.stringify(this.report, null, 2),
      )
      assert.deepEqual(this.errors, [], "A page of Studio's threw")
    } finally {
      await this.browser.close()
    }
  }
}

let started: Promise<TestHost> | undefined

/** The latkit the extension was built with, as a benchmark names its renderer: only runs on the
 *  same one compare their work. */
export async function renderer(): Promise<string> {
  const path = join(process.env.GRIDKIT_TEST_ROOT!, 'node_modules', 'latkit', 'package.json')
  return 'latkit@' + (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version
}

/** The one TestHost, reset: every suite starts from the case alone in its Network editor, so each
 *  runs alone as it does among the others. */
export async function testHost(): Promise<TestHost> {
  const bench = await (started ??= TestHost.start())
  await bench.reset()
  return bench
}

/** What VS Code says of the test profile itself, which `--disable-extensions` causes. */
const PROFILE_NOTICES = new Set(['All installed extensions are temporarily disabled.'])
/** A run's own progress, titled by its program and solver file, which says how far it has come
 *  rather than that anything failed. A notice that a run failed names it the same way. */
const PROGRESS = /^\S+ .+?\.solver\.json\b(?!.*\bfailed\b)/i

/** The notifications VS Code shows, which are then cleared. Studio shows one only when something
 *  the user asked for fails, so a test that sees one expected it or found a fault. */
export async function notifications(): Promise<string[]> {
  const bench = await started?.catch(() => undefined)
  if (!bench) return []
  const shown = await bench.page
    .locator('.notifications-toasts .notification-list-item-message')
    .filter({ visible: true })
    .allInnerTexts()
  const said = shown.filter(
    (text) => !PROFILE_NOTICES.has(text.trim()) && !PROGRESS.test(text.trim()),
  )
  // Cleared only once there is something to say: clearing a run's progress alone would clear the
  // failure that follows it as it shows.
  if (said.length) await vscode.commands.executeCommand('notifications.clearAll')
  return said
}

/** Keep what VS Code showed when `test` failed. */
export async function failed(test: string): Promise<void> {
  await (await started?.catch(() => undefined))?.failed(test)
}

/** Close the run: its report is written, and a page that threw fails it. */
export async function finish(): Promise<void> {
  await (await started?.catch(() => undefined))?.finish()
}
