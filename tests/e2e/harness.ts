/** The host tests' bench, also driven by Playwright over the window's DevTools port. */

import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { type Browser, chromium, type Frame, type Locator, type Page } from 'playwright-core'
import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import { gridkitOf } from '../../src/extension/settings.js'
import type { Studio } from '../../src/extension/studio.js'
import { available } from '../../src/gridkit/index.js'
import type { Results, ViewKind } from '../../src/shared/messages.js'
import { monitorWith } from '../../src/shared/monitors.js'
import { Bench, extension, folder } from '../host/studio.js'

export { extension, type Solver } from '../host/studio.js'

const TIMEOUT = 30_000
/** For reading what the page shows right now, not waiting for a change. */
const READ = { timeout: 1000 }
const SYNTHETIC = 'Synthetic waveform.csv'

export const VIEWPORT = { width: 1600, height: 1000 }

export const VM = { table: 'Bus', field: 'Vm' } as const

/** Polls `get` until truthy; unlike the bench's event-driven `until`, this works on page state. */
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

/** Repeats `act` every `settle` ms until `done` is true, since VS Code drops input while busy (a
 *  right-click that opens no menu, a click that does not register). */
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

export async function visible(frame: Frame, selector: string): Promise<void> {
  try {
    await frame.locator(selector).first().waitFor({ state: 'visible', timeout: TIMEOUT })
  } catch (error) {
    throw new Error(`${selector} never showed. The page held ${await pageSummary(frame)}`, {
      cause: error,
    })
  }
}

const pageSummary = (frame: Frame) =>
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

export const stats = <T extends { frames: number } = { frames: number }>(frame: Frame) =>
  frame.evaluate<T>('gridkitStats()')

/** Waits for a canvas view to stop drawing and returns its counters. */
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

/** Restarts playback each time it stops at the end, for measurements longer than the results. */
export function replaying(studio: Studio, session: Session): vscode.Disposable {
  const { transport } = session
  return studio.clock.event((uri) => {
    const { status, t, span } = transport.state
    if (uri === session.uri && status === 'paused' && t >= span[1]) transport.play()
  })
}

/** Switches to VS Code's own file dialog, which tests type into; `undefined` restores the OS's. */
export const simpleDialog = (on: true | undefined) =>
  vscode.workspace
    .getConfiguration()
    .update('files.simpleDialog.enable', on, vscode.ConfigurationTarget.Global)

async function attach(): Promise<{ browser: Browser; page: Page }> {
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const page = browser.contexts().flatMap((context) => context.pages())[0]!
  await page.setViewportSize(VIEWPORT)
  return { browser, page }
}

const PANELS = {
  case: 'gridkitStudio.openCasePanel',
  monitor: 'gridkitStudio.openMonitor',
  export: 'gridkitStudio.exportVideo',
} as const

/** The bench plus Playwright access to the window's views, menus and prompts. */
export class TestHost extends Bench {
  readonly report: Record<string, unknown>
  readonly errors: string[] = []
  /** Errors thrown by VS Code's own code; reported but not failing the run. */
  readonly vscodeErrors: string[] = []

  private constructor(
    readonly browser: Browser,
    readonly page: Page,
    text: string,
    readonly output: string,
    solver: string,
  ) {
    super(text, solver)
    const { packageJSON } = extension()
    this.report = {
      vscodeVersion: vscode.version,
      extensionVersion: packageJSON.version,
      latkit: packageJSON.dependencies,
    }
    page.on('pageerror', (error) => {
      const text = error.stack ?? error.message
      // Errors from outside Studio's bundles come from VS Code.
      ;(/[\\/]dist[\\/]webview[\\/]/.test(text) ? this.errors : this.vscodeErrors).push(text)
    })
  }

  static override async start(): Promise<TestHost> {
    const installed = extension()
    const uri = vscode.Uri.joinPath(folder(), 'IEEE39.case.json')
    // Connect before any view opens: Playwright may never see frames attached before it connected.
    const { browser, page } = await attach()
    const started = performance.now()
    // Opening a case activates the extension; nothing here calls activate().
    await vscode.commands.executeCommand('vscode.open', uri)
    await until(() => installed.isActive, 'a case opening activates the extension')
    const openCaseMs = performance.now() - started
    const output = process.env.GRIDKIT_TEST_OUTPUT!
    await mkdir(join(output, 'playwright'), { recursive: true })
    await mkdir(join(output, 'tests'), { recursive: true })
    const text = await readFile(uri.fsPath, 'utf8')
    const solver = await readFile(
      vscode.Uri.joinPath(folder(), 'IEEE39.solver.json').fsPath,
      'utf8',
    )
    const bench = new TestHost(browser, page, text, output, solver)
    bench.report.openCaseMs = openCaseMs
    return bench
  }

  #frames(): Frame[] {
    return this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .flatMap((page) => page.frames())
  }

  async #webviews(): Promise<string[]> {
    const seen: string[] = []
    for (const frame of this.#frames()) {
      const body = await frame
        .evaluate<Record<string, string>>('({ ...document.body.dataset })')
        .catch(() => undefined)
      if (body?.kind)
        seen.push(
          `${body.kind}${body.visible === 'false' ? ' (hidden)' : ''} of ${body.uri || 'no case yet'}`,
        )
    }
    return seen
  }

  view(kind: ViewKind, uri?: string): Promise<Frame> {
    return until(
      async () => {
        for (const candidate of this.#frames())
          if (
            await candidate
              .locator('body[data-kind="' + kind + '"]:not([data-visible="false"])')
              .isVisible()
              .catch(() => false)
          )
            if (!uri || (await candidate.evaluate<string>('document.body.dataset.uri')) === uri)
              return candidate
      },
      async () => {
        const tabs = vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .map((tab) =>
            tab.input instanceof vscode.TabInputCustom
              ? `${tab.label} (${tab.input.viewType})`
              : tab.label,
          )
        return (
          `${kind} webview${uri ? ' of ' + uri : ''}, among: ${(await this.#webviews()).join('; ') || 'none'}` +
          ` (${this.#frames().length} frames; tabs: ${tabs.join(', ') || 'none'})`
        )
      },
    )
  }

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

  /** Copies a case into the workspace and opens it alone in the Network. */
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

  async show(kind: keyof typeof PANELS): Promise<Frame> {
    await vscode.commands.executeCommand(PANELS[kind], this.uri)
    return this.view(kind)
  }

  /** A status bar playback item by name prefix: Previous Sample, Play, Pause, Replay, Next Sample,
   *  Go to Time or Playback Speed. */
  playback(name: string): Locator {
    return this.page
      .locator('.part.statusbar')
      .getByRole('button', { name: new RegExp('^' + name) })
  }

  // ── Commands, run as the manifest's menus offer them, without VS Code's popups ──

  /** Runs `item` from the active editor's title bar (More Actions included) once it is enabled. */
  async title(item: string): Promise<void> {
    const editor = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const keys = () => {
      const active = editor()
      return {
        ...this.keys(),
        activeCustomEditorId: active instanceof vscode.TabInputCustom ? active.viewType : '',
      }
    }
    const find = () => this.menus.find('editor/title', item, keys())
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
    this.command(command, (editor() as vscode.TabInputCustom).uri)
  }

  /** Runs `item` from the Explorer context menu on `uri` without waiting for it. */
  explorer(item: string, uri = this.solver): void {
    const keys = { ...this.keys(), resourceFilename: basename(uri.path) }
    const { command } = this.menus.find('explorer/context', item, keys)
    this.command(command, uri, [uri])
  }

  // ── VS Code's own prompts, answered from the keyboard ──

  /** The visible quick input: a quick pick, input box or file dialog. Read it with `READ`, since it
   *  may close between two reads. */
  #quickInput() {
    const widget = this.page.locator('.quick-input-widget:visible')
    return { widget, input: widget.locator('.quick-input-box input').first() }
  }

  async #promptTitle(): Promise<string> {
    const { widget, input } = this.#quickInput()
    await input.waitFor({ state: 'visible' })
    return widget
      .locator('.quick-input-title')
      .innerText(READ)
      .catch(() => '')
  }

  /** Presses Enter on the prompt titled `asked` until it accepts `entered` (closes or changes).
   *  Enter is pressed only while that prompt still shows that text. */
  async #submit(asked: string, entered: string): Promise<void> {
    const { widget, input } = this.#quickInput()
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

  async dialog(path: string): Promise<void> {
    const { input } = this.#quickInput()
    // The dialog starts with a folder path; a picker that is still closing shows other text.
    await until(
      async () => /[\\/]/.test(await input.inputValue(READ).catch(() => '')),
      'the file dialog',
    )
    const asked = await this.#promptTitle()
    await input.fill(path)
    await this.#submit(asked, path)
  }

  async capture(name: string): Promise<void> {
    await vscode.commands.executeCommand('notifications.clearAll')
    await pause(300)
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
  }

  /** One second of every bus's voltage, first bus plotted; reuses the results already shown. */
  async results(): Promise<Results> {
    const shown = this.session.results
    if (shown?.name === SYNTHETIC && !shown.growing) return shown
    const results = await this.waveform(SYNTHETIC, 100, 1)
    this.plot()
    return results
  }

  /** Writes `frames` samples of phase-shifted bus voltages over `seconds` to `name`; loads it. */
  async waveform(name: string, frames: number, seconds: number): Promise<Results> {
    const csv = vscode.Uri.joinPath(this.uri, '..', name)
    const { buses } = this.source
    const voltage = (i: number, k: number) => 1 + 0.1 * Math.sin(i / 10 + k)
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

  /** Shows the Vm monitor narrowed to the first bus. */
  plot(): void {
    this.session.setMonitor(monitorWith(VM, this.source.buses[0]!.number, undefined))
    this.session.showMonitor(VM)
  }

  /** The GridKit build in use, since timings differ between builds. */
  async gridkitBuild(): Promise<string> {
    const runtime = await available(gridkitOf(this.uri))
    if (runtime.kind === 'installed') return runtime.program
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(extension().extensionUri, 'dist/solver/build.json'),
    )
    return (JSON.parse(new TextDecoder().decode(bytes)) as { artifact: string }).artifact
  }

  /** Restores the case, alone in its Network editor, with nothing selected or mapped. */
  override async reset(): Promise<void> {
    // A prompt left open by a test would receive the next test's keys.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    await this.restore()
    await this.open()
    await this.settled()
    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups')
    await vscode.commands.executeCommand('workbench.action.closeOtherEditors')
    const { session } = this
    this.clean(session)
    session.show(undefined)
  }

  /** Logs every view's state, and saves a screenshot and the run's files, after `test` failed. */
  async failed(test: string): Promise<void> {
    const session = this.studio.get(this.key)
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
    // A run left going would slow every later test.
    session?.stop()
    const name = 'failure-' + test.replace(/[^\w]+/g, '-').toLowerCase()
    await this.page.screenshot({ path: join(this.output, 'playwright', name + '.png') })
    const { run, results } = session ?? {}
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

  /** Writes the report and closes the browser; a page error fails the run. */
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

/** The renderer name benchmarks record; only runs on the same latkit version are compared. */
export async function renderer(): Promise<string> {
  const path = join(process.env.GRIDKIT_TEST_ROOT!, 'node_modules', 'latkit', 'package.json')
  return 'latkit@' + (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version
}

/** The shared TestHost, reset so each suite starts from the same state. */
export async function testHost(): Promise<TestHost> {
  const bench = await (started ??= TestHost.start())
  await bench.reset()
  return bench
}

/** Shown because of `--disable-extensions`. */
const PROFILE_NOTICES = new Set(['All installed extensions are temporarily disabled.'])
/** A run's progress notification (program and solver file), excluding failure notices. */
const PROGRESS = /^\S+ .+?\.solver\.json\b(?!.*\bfailed\b)/i

/** Returns and clears the visible notifications, minus profile notices and run progress. */
export async function notifications(): Promise<string[]> {
  const bench = await started?.catch(() => undefined)
  if (!bench) return []
  const texts = await bench.page
    .locator('.notifications-toasts .notification-list-item-message')
    .filter({ visible: true })
    .allInnerTexts()
  const unexpected = texts.filter(
    (text) => !PROFILE_NOTICES.has(text.trim()) && !PROGRESS.test(text.trim()),
  )
  // Clearing progress alone could also clear a failure that is about to show.
  if (unexpected.length) await vscode.commands.executeCommand('notifications.clearAll')
  return unexpected
}

export async function failed(test: string): Promise<void> {
  await (await started?.catch(() => undefined))?.failed(test)
}

export async function finish(): Promise<void> {
  await (await started?.catch(() => undefined))?.finish()
}
