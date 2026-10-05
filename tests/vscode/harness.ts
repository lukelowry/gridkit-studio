/** The VS Code under test: the extension and a case, driven from inside through the extension's
 *  exports and from outside by Playwright over the window's DevTools port. */

import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { type Browser, chromium, type Frame, type Locator, type Page } from 'playwright-core'
import * as vscode from 'vscode'

import { defaultOutputs, type Sessions } from '../../src/extension/sessions.js'
import { gridkitOf } from '../../src/extension/tasks.js'
import { available } from '../../src/gridkit/index.js'
import type { RunInfo, ViewKind } from '../../src/shared/messages.js'

const TIMEOUT = 30_000

/** The window size every suite starts from. */
export const VIEWPORT = { width: 1600, height: 1000 }

/** A bus's recorded voltage magnitude: the signal the suites map, plot and play. */
export const VM = { type: 'Bus', field: 'Vm' } as const

/** Wait until `get` answers something truthy, and return it. */
export async function until<T>(
  get: () => Promise<T> | T,
  label: string,
  timeout = TIMEOUT,
): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await get()
    if (value) return value as NonNullable<T>
    await pause(100)
  }
  throw new Error('Timed out: ' + label)
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Wait for `selector` to show in `frame`. */
export async function visible(frame: Frame, selector: string): Promise<void> {
  await frame.locator(selector).first().waitFor({ state: 'visible', timeout: TIMEOUT })
}

/** A canvas view's counters, as `gridkitStats()` reports them. */
export const stats = <T extends { frames: number } = { frames: number }>(frame: Frame) =>
  frame.evaluate<T>('gridkitStats()')

/** How many frames a canvas view has drawn. */
export const frames = (frame: Frame) => frame.evaluate<number>('gridkitStats().frames')

/** Wait for a canvas view to stop drawing, and return its counters. */
export async function idle<T extends { frames: number } = { frames: number }>(
  frame: Frame,
): Promise<T> {
  let last = await stats<T>(frame)
  for (;;) {
    await pause(250)
    const now = await stats<T>(frame)
    if (now.frames === last.frames) return now
    last = now
  }
}

/** Whether a canvas view's canvas fills its webview edge to edge, with no padding around it. */
export const fills = (frame: Frame) =>
  frame.evaluate<boolean>(`(() => {
  const r = document.querySelector('canvas').getBoundingClientRect()
  return [r.x, r.y, r.width - innerWidth, r.height - innerHeight].every((v) => Math.abs(v) < 1) &&
    getComputedStyle(document.body).padding === '0px'
})()`)

/** Set the color theme for the whole profile; `undefined` restores the default. */
export const theme = (name: string | undefined) =>
  vscode.workspace
    .getConfiguration()
    .update('workbench.colorTheme', name, vscode.ConfigurationTarget.Global)

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
  simulation: 'gridkitStudio.simulation.focus',
} as const

export class TestHost {
  /** The case's source as the suites found it, and as each suite starts. */
  readonly text: string
  /** That source, parsed. */
  readonly source: {
    buses: { number: number; name: string; params: { kv: number } }[]
    devices: { extension?: { diagram?: unknown } }[]
  }
  /** What the run measured, written beside the screenshots when it ends. */
  readonly report: Record<string, unknown>
  /** Errors thrown in VS Code's pages. */
  readonly errors: string[] = []
  #results?: Promise<RunInfo>

  private constructor(
    readonly extension: vscode.Extension<{ studio: Sessions }>,
    readonly browser: Browser,
    /** The VS Code window. */
    readonly page: Page,
    readonly document: vscode.TextDocument,
    /** Where screenshots and the report are written. */
    readonly output: string,
  ) {
    this.text = document.getText()
    this.source = JSON.parse(this.text)
    this.report = {
      vscodeVersion: vscode.version,
      extensionVersion: extension.packageJSON.version,
      latkit: extension.packageJSON.dependencies,
    }
    page.on('pageerror', (error) => this.errors.push(error.stack ?? error.message))
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
    const document = await vscode.workspace.openTextDocument(uri)
    const bench = new TestHost(installed, browser, page, document, output)
    bench.report.openCaseMs = openCaseMs
    return bench
  }

  get studio(): Sessions {
    return this.extension.exports.studio
  }
  get uri(): vscode.Uri {
    return this.document.uri
  }
  /** The case's key among the sessions. */
  get key(): string {
    return this.uri.toString()
  }
  get session() {
    return this.studio.all.get(this.key)!
  }

  /** Every frame of every VS Code page, webviews' included. */
  #frames(): Frame[] {
    return this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .flatMap((page) => page.frames())
  }

  /** The webview showing `kind`. */
  view(kind: ViewKind): Promise<Frame> {
    return until(async () => {
      for (const candidate of this.#frames())
        if (
          await candidate
            .locator('body[data-kind="' + kind + '"]')
            .isVisible()
            .catch(() => false)
        )
          return candidate
    }, kind + ' webview')
  }

  /** Show the case in a canvas editor, and wait for its first frame. */
  async open(kind: 'network' | 'diagram', column = vscode.ViewColumn.One): Promise<Frame> {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      this.uri,
      'gridkitStudio.' + kind,
      column,
    )
    const frame = await this.view(kind)
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
    await until(() => this.studio.documents.entries.get(uri.toString())?.summary, name + ' parsed')
    return { uri, network }
  }

  /** Show one of the case's panel views. */
  async show(kind: keyof typeof PANELS): Promise<Frame> {
    const command = PANELS[kind]
    await vscode.commands.executeCommand(command, ...(command.endsWith('.focus') ? [] : [this.uri]))
    return this.view(kind)
  }

  /** Monitored Signals, the native tree of what the next run records, once it shows. Unless
   *  `reveal` is false, its own command shows it first. */
  async signals({ reveal = true } = {}): Promise<Locator> {
    if (reveal) await vscode.commands.executeCommand('gridkitStudio.signals.focus')
    const pane = this.page.locator('.pane', {
      has: this.page.locator('.pane-header', { hasText: /monitored signals/i }),
    })
    await pane.getByRole('treeitem').first().waitFor({ state: 'visible', timeout: TIMEOUT })
    return pane
  }

  /** Check or uncheck `field` of `type` in Monitored Signals as the user does: open its type,
   *  then click its box. */
  async toggleSignal(type: string, field: string): Promise<void> {
    const signals = await this.signals()
    const group = signals.getByRole('treeitem', { name: new RegExp(`^${type},`) })
    if ((await group.getAttribute('aria-expanded')) !== 'true') {
      await group.locator('.monaco-tl-twistie').click()
      await until(
        async () => (await group.getAttribute('aria-expanded')) === 'true',
        type + ' open',
      )
    }
    await signals
      .getByRole('treeitem', { name: new RegExp(`^${type} ${field}\\b`) })
      .getByRole('checkbox')
      .click()
  }

  /** Wait for a native menu to offer `item`. */
  async offered(item: string): Promise<void> {
    await this.page
      .getByRole('menuitem')
      .filter({ hasText: item })
      .first()
      .waitFor({ state: 'visible' })
  }

  /** Choose `item` from the native menu on show, as the user does: point at it, then click. */
  async choose(item: string): Promise<void> {
    const entry = this.page.getByRole('menuitem', { name: new RegExp('^' + item) })
    await entry.waitFor({ state: 'visible' })
    await entry.hover()
    await entry.click()
    await entry.waitFor({ state: 'detached' })
  }

  /** Save a picture of the whole VS Code window. */
  async capture(name: string): Promise<void> {
    await vscode.commands.executeCommand('notifications.clearAll')
    await pause(300)
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
  }

  /** The case as the worker last read it. */
  current() {
    return this.studio.documents.ensure(this.document)
  }

  /** Wait for the views' case to be the document's own revision. */
  async settled(): Promise<void> {
    await until(() => {
      const state = this.studio.state(this.key)
      return state.summary?.version === this.document.version && !state.stale
    }, 'the case follows its document')
  }

  /** Replace the case's whole source, unsaved. */
  async replace(text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(this.uri, new vscode.Range(0, 0, this.document.lineCount, 0), text)
    await vscode.workspace.applyEdit(edit)
  }

  /** Undo natively in the case's source, back to how the suites found it. */
  async undo(label: string): Promise<void> {
    await vscode.window.showTextDocument(this.document)
    await vscode.commands.executeCommand('undo')
    await until(() => this.document.getText() === this.text, label)
    await this.settled()
  }

  /** A run to play: a second of every bus's voltage, each a little out of step with the last,
   *  imported once, with the first bus's plotted. */
  results(): Promise<RunInfo> {
    return (this.#results ??= this.#import())
  }
  async #import(): Promise<RunInfo> {
    const csv = vscode.Uri.joinPath(this.uri, '..', 'Synthetic waveform.csv')
    const { buses } = this.source
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(
        ['time', ...buses.map((bus) => 'Bus_' + bus.name + '_Vm')] +
          '\n' +
          Array.from(
            { length: 100 },
            (_, i) => [i / 100, ...buses.map((_, k) => 1 + 0.1 * Math.sin(i / 10 + k))] + '\n',
          ).join(''),
      ),
    )
    const run = await this.studio.client.call('import', {
      uri: this.key,
      version: (await this.current()).version,
      path: csv.fsPath,
      cacheBytes: 32 << 20,
    })
    assert.equal(run.state, 'complete', run.message)
    await until(() => this.session.run?.id === run.id, 'the imported run on show')
    this.plot()
    return run
  }

  /** Plot the first bus's voltage in the Monitor. */
  plot(): void {
    this.session.plots = [
      { from: VM.type, field: VM.field, id: 'Bus/' + this.source.buses[0]!.number },
    ]
    this.studio.changed.fire(this.key)
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

  /** Back to the case alone in its Network editor: its source as found and saved, nothing
   *  selected or mapped, its clock at rest. */
  async reset(): Promise<void> {
    if (this.session?.run?.state === 'running')
      await this.studio.client.call('stop', { uri: this.key })
    if (this.document.getText() !== this.text) await this.replace(this.text)
    if (this.document.isDirty) await this.document.save()
    await this.open('network')
    await this.settled()
    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups')
    await vscode.commands.executeCommand('workbench.action.closeOtherEditors')
    const { session } = this
    this.studio.select(this.key)
    session.values = {}
    session.outputs = defaultOutputs(await this.current())
    session.plots = []
    session.bindings = {}
    session.diagramEditing = false
    session.cameras = {}
    session.table = {}
    this.studio.show(session, undefined)
    session.transport.setLoop('none')
    session.transport.setRate(1)
    this.#results = undefined
    await this.studio.persist(session)
    this.studio.changed.fire(this.key)
  }

  /** Keep what every view showed when `test` failed, with the files of its runs. */
  async failed(test: string): Promise<void> {
    const name = 'failure-' + test.replace(/[^\w]+/g, '-').toLowerCase()
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
    for (const run of [this.session?.run, this.session?.previous]) {
      if (!run) continue
      const directory = join(this.output, 'tests', name, run.id)
      await mkdir(directory, { recursive: true })
      for (const file of ['case.json', 'input.json', 'solver.log'])
        await cp(join(dirname(run.path), file), join(directory, file)).catch(() => {})
      await writeFile(join(directory, 'run.json'), JSON.stringify(run, null, 2))
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
      this.report.worker = await this.studio.client.call('stats', {})
      this.report.pageErrors = this.errors
      await writeFile(
        join(this.output, 'tests', 'vscode-report.json'),
        JSON.stringify(this.report, null, 2),
      )
      assert.deepEqual(this.errors, [], 'A VS Code page threw')
    } finally {
      await this.browser.close()
    }
  }
}

let started: Promise<TestHost> | undefined

/** The one TestHost, reset: every suite starts from the case alone in its Network editor, so each
 *  runs alone as it does among the others. */
export async function testHost(): Promise<TestHost> {
  const bench = await (started ??= TestHost.start())
  await bench.reset()
  return bench
}

/** What VS Code says of the test profile itself, which `--disable-extensions` causes. */
const PROFILE_NOTICES = new Set(['All installed extensions are temporarily disabled.'])

/** The notifications VS Code shows, which are then cleared. Studio shows one only when something
 *  the user asked for fails, so a test that sees one expected it or found a fault. */
export async function notifications(): Promise<string[]> {
  const bench = await started?.catch(() => undefined)
  if (!bench) return []
  const shown = await bench.page
    .locator('.notifications-toasts .notification-list-item-message')
    .filter({ visible: true })
    .allInnerTexts()
  if (shown.length) await vscode.commands.executeCommand('notifications.clearAll')
  return shown.filter((text) => !PROFILE_NOTICES.has(text.trim()))
}

/** Keep what VS Code showed when `test` failed. */
export async function failed(test: string): Promise<void> {
  await (await started?.catch(() => undefined))?.failed(test)
}

/** Close the run: its report is written, and a page that threw fails it. */
export async function finish(): Promise<void> {
  await (await started?.catch(() => undefined))?.finish()
}
