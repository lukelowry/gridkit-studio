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
import type { SimulationInfo, ViewKind } from '../../src/shared/messages.js'
import { type Keys, type Manifest, Menus } from '../menus.js'

const TIMEOUT = 30_000

/** The title bars `title` runs commands from: a panel or side bar view's, or the custom editor's
 *  in front. */
export type TitleBar = 'case' | 'monitor' | 'simulation' | 'signals' | 'export' | 'editor'

/** A label `name` starts with, as a pattern. */
const starting = (name: string) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

/** What the probe touches in a page, which the host's own code has no DOM library to name. */
interface Probed {
  closest(selector: string): Probed | null
  readonly parentElement: Probed | null
  readonly dataset: Readonly<Record<string, string | undefined>>
  readonly ownerDocument: {
    readonly defaultView: unknown
    addEventListener(
      type: 'contextmenu',
      listener: (event: {
        readonly target: Probed | null
        preventDefault(): void
        stopPropagation(): void
      }) => void,
      capture: boolean,
    ): void
  }
}
/** The probe's state, on the page's window: the menus caught since it was armed. */
interface Probing {
  gridkitMenus?: Record<string, unknown>[]
  gridkitProbe?: boolean
  gridkitProbing?: boolean
}

/** Catch the menus right-clicks in the page of `node` open, as VS Code reads them, and keep VS Code
 *  from opening any while armed, so none is left open over the views. Run in the page: it reaches
 *  for nothing outside itself. */
const probe = (node: Probed) => {
  const page = node.ownerDocument.defaultView as Probing
  page.gridkitMenus = []
  page.gridkitProbing = true
  if (page.gridkitProbe) return
  page.gridkitProbe = true
  node.ownerDocument.addEventListener(
    'contextmenu',
    (event) => {
      if (!page.gridkitProbing) return
      // Each element's context up the tree, the nearest winning, as VS Code merges them.
      let context: Record<string, unknown> = {}
      for (
        let at = event.target?.closest('[data-vscode-context]');
        at;
        at = at.parentElement?.closest('[data-vscode-context]')
      )
        context = { ...JSON.parse(at.dataset.vscodeContext!), ...context }
      // A canvas's own right-click carries nothing: its view opens the menu once it has found
      // what lies under the pointer.
      if (!('gridkitTarget' in context)) return
      // VS Code leaves a menu someone handled to them, and never hears of one gone no further.
      event.preventDefault()
      event.stopPropagation()
      page.gridkitMenus?.push(context)
    },
    true,
  )
}

/** The window size every suite starts from. */
export const VIEWPORT = { width: 1600, height: 1000 }

/** A bus's recorded voltage magnitude: the signal the suites map, plot and play. */
export const VM = { type: 'Bus', field: 'Vm' } as const

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

/** VS Code's own file dialog, which a test can type a path into; `undefined` restores the OS's. */
export const simpleDialog = (on: true | undefined) =>
  vscode.workspace
    .getConfiguration()
    .update('files.simpleDialog.enable', on, vscode.ConfigurationTarget.Global)

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
  /** Errors Studio's own pages threw. */
  readonly errors: string[] = []
  /** Errors VS Code's own code threw in its pages, kept in the report: VS Code's to fix. */
  readonly vscodeErrors: string[] = []
  /** Where the installed manifest places Studio's commands. */
  readonly menus: Menus
  #results?: Promise<SimulationInfo>

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
    const box = signals
      .getByRole('treeitem', { name: new RegExp(`^${type} ${field}\\b`) })
      .getByRole('checkbox')
    // Done once what the next run records changes, not once the box looks it: a tree drawn again
    // for another case can change the box when no click took.
    const recorded = () =>
      !!this.session.outputs?.some(({ from, select }) => from === type && select.includes(field))
    const was = recorded()
    // A box the pointer rests on shows its state in a hover over the row below: the pointer leaves
    // before and after each click, so no hover covers the next box.
    await again(
      async () => {
        await this.page.mouse.move(0, 0)
        await box.click({ timeout: 2000 }).catch(() => {})
        await this.page.mouse.move(0, 0)
      },
      () => recorded() !== was,
      `${type} ${field} ${was ? 'no longer recorded' : 'recorded'}`,
    )
  }

  /** A playback item of the status bar by the start of its name: Previous sample, Play, Pause,
   *  Replay, Next sample, Time, Speed, Go to end or Go live. */
  playback(name: string): Locator {
    return this.page
      .locator('.part.statusbar')
      .getByRole('button', { name: new RegExp('^' + name) })
  }

  /** The times the status bar's playback shows: the playhead, then the end. */
  async times(): Promise<number[]> {
    const text = await this.playback('Time').innerText()
    return (text.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number)
  }

  /** The button `action` on a notification on show. */
  notice(action: string): Locator {
    return this.page
      .locator('.notifications-toasts .notification-list-item')
      .getByRole('button', { name: action })
      .first()
  }

  // ── Commands, from where the user finds them ──
  //
  // A view decides what its menus carry, the manifest decides what each place offers, and the
  // command decides what it does: those are Studio's, and the suites check them all here. Drawing
  // a popup and calling the command with what it carries are VS Code's, which the Native menus
  // suite checks against the manifest. So a right-click here is the user's own, on the thing
  // itself, but what it opens is read as VS Code reads it, and its item is run as VS Code runs
  // it, without waiting on a popup VS Code may drop.

  /** The context keys VS Code holds for title bars and the Command Palette: Studio's own, and the
   *  workspace's trust. */
  keys(): Keys {
    return {
      ...Object.fromEntries(
        [...this.studio.contexts].map(([key, value]) => ['gridkitStudio.' + key, value]),
      ),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    }
  }

  /** What a right-click on `target`, at `position` in it, carries to VS Code's menu: its
   *  `data-vscode-context` merged up the tree, or what a canvas view found under the pointer. A
   *  right-click VS Code dropped while busy is clicked again, but only well after a canvas view
   *  could have answered it, as each click opens a menu of its own. */
  async carried(
    target: Locator,
    position?: { x: number; y: number },
  ): Promise<Record<string, unknown>> {
    const caught = () =>
      target.evaluate(
        (node: Probed) => (node.ownerDocument.defaultView as Probing).gridkitMenus ?? [],
      )
    await target.evaluate(probe)
    await again(
      () => target.click({ button: 'right', position, timeout: 2000 }).catch(() => {}),
      async () => (await caught()).length > 0,
      'a menu opened on ' + target,
      TIMEOUT,
      10_000,
    )
    return (await caught())[0]!
  }

  /** Let VS Code open the menus right-clicks open again, in every page the probe watches. */
  async #unprobe(): Promise<void> {
    for (const frame of this.#frames())
      await frame
        .evaluate(() => {
          ;(globalThis as Probing).gridkitProbing = false
        })
        .catch(() => {})
  }

  /** The titles of what a right-click on `target` offers, as VS Code would show them. */
  async offered(target: Locator, position?: { x: number; y: number }): Promise<string[]> {
    const context = await this.carried(target, position)
    return this.menus.offered('webview/context', context).map((each) => each.title)
  }

  /** Right-click `target`, at `position` in it, and choose `item` from what it offers. */
  async menu(target: Locator, item: string, position?: { x: number; y: number }): Promise<void> {
    const context = await this.carried(target, position)
    const { command } = this.menus.find('webview/context', item, context)
    assert.ok(this.menus.enabled(command, { ...this.keys(), ...context }), item + ' enabled')
    const origin = context.gridkitOrigin as string
    this.#run(command, { ...context, webview: 'gridkitStudio.' + origin })
  }

  /** Choose `item` from the title bar of `where`, its More Actions included, once it is offered
   *  there and enabled. */
  async title(where: TitleBar, item: string): Promise<void> {
    const editor = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const place = where === 'editor' ? 'editor/title' : 'view/title'
    const keys = () => ({
      ...this.keys(),
      ...(where === 'editor'
        ? { activeCustomEditorId: editor instanceof vscode.TabInputCustom ? editor.viewType : '' }
        : { view: 'gridkitStudio.' + where }),
    })
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
    if (where === 'editor') this.#run(command, (editor as vscode.TabInputCustom).uri)
    else this.#run(command)
  }

  /** Show the elements of `type` in the Case panel, from its title bar, and wait for the panel to
   *  say it shows them: what the panel shows is what its title bar's commands act on. */
  async caseType(type: string): Promise<void> {
    await this.title('case', 'Choose Type')
    await this.pick(new RegExp('^' + type, 'i'), type)
    await until(() => this.session.table.type === type, 'the Case panel shows ' + type)
  }

  /** Start a run from the Simulation view's title bar, once no run holds it. What keeps a run from
   *  starting is said in a notification. */
  start(): Promise<void> {
    return this.title('simulation', 'Start Simulation')
  }

  /** Stop the run from the Simulation view's title bar. */
  stop(): Promise<void> {
    return this.title('simulation', 'Stop Simulation')
  }

  /** Choose `item` from the Explorer's menu on the file `uri`. */
  explorer(uri: vscode.Uri, item: string): void {
    const keys = { ...this.keys(), resourceFilename: basename(uri.path) }
    const { command } = this.menus.find('explorer/context', item, keys)
    this.#run(command, uri, [uri])
  }

  /** Run the command titled `title` from the Command Palette, once it is enabled. */
  async palette(title: string): Promise<void> {
    const { command } = this.menus.palette(title, this.keys())
    await until(() => this.menus.enabled(command, this.keys()), title + ' enabled')
    this.#run(command)
  }

  /** Run `command` as VS Code does from a menu: without waiting on it, as one that asks something
   *  waits for its answer. A command's failure is reported, which fails the test. */
  #run(command: string, ...args: unknown[]): void {
    void vscode.commands
      .executeCommand(command, ...args)
      .then(undefined, (error: unknown) => this.studio.error(error))
  }

  // ── VS Code's own prompts, answered from the keyboard ──

  /** The quick input on show: a quick pick, an input box, or a file dialog. */
  #prompt() {
    const widget = this.page.locator('.quick-input-widget')
    return { widget, input: widget.locator('.quick-input-box input').first() }
  }

  /** The title of the prompt on show, which says what it asks. */
  async #asked(): Promise<string> {
    const { widget, input } = this.#prompt()
    await input.waitFor({ state: 'visible' })
    return widget
      .locator('.quick-input-title')
      .innerText()
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
        .innerText()
        .catch(() => '')) === asked &&
      (await input.inputValue().catch(() => '')) === entered
    await again(
      async () => {
        if (await asking()) await input.press('Enter', { timeout: 2000 }).catch(() => {})
      },
      async () => !(await asking()),
      'the prompt takes ' + (entered || 'the answer'),
    )
  }

  /** Answer the quick pick on show with its item whose label starts with `label`, or whose whole
   *  row, its description included, matches the pattern `label`: `typed` filters the list, the item
   *  is made the active one, and Enter takes it. */
  async pick(
    label: string | RegExp,
    typed = typeof label === 'string' ? label : '',
  ): Promise<void> {
    const { widget, input } = this.#prompt()
    const asked = await this.#asked()
    await input.fill(typed)
    const rows =
      typeof label === 'string'
        ? widget.locator('.monaco-list-row', {
            has: this.page.locator('.label-name', { hasText: starting(label) }),
          })
        : widget.locator('.monaco-list-row', { hasText: label })
    const active = rows.and(widget.locator('.monaco-list-row.focused'))
    // Typing makes the first match active; one further down is reached with the arrow keys.
    await until(async () => {
      if (await active.count()) return true
      if (await rows.count()) await input.press('ArrowDown')
      return false
    }, `${label} offered`)
    await this.#take(asked, typed)
  }

  /** Check each of `labels` in the multiple-choice pick on show, or uncheck it, then take the
   *  choice. Typing finds each, as a long list draws only the rows in view. */
  async check(labels: readonly string[], checked = true): Promise<void> {
    const { widget, input } = this.#prompt()
    const asked = await this.#asked()
    for (const label of labels) {
      await input.fill(label)
      const box = widget
        .locator('.monaco-list-row', {
          has: this.page.locator('.label-name', { hasText: starting(label) }),
        })
        .getByRole('checkbox')
        .first()
      // Done once the box shows it, which is what Enter takes.
      await again(
        () => box.click({ timeout: 2000 }).catch(() => {}),
        async () => (await box.isChecked({ timeout: 1000 }).catch(() => !checked)) === checked,
        `${label} ${checked ? 'checked' : 'unchecked'}`,
      )
    }
    await this.#take(asked, labels.at(-1) ?? '')
  }

  /** Answer the input box on show with `text`. */
  async answer(text: string): Promise<void> {
    const { input } = this.#prompt()
    const asked = await this.#asked()
    await input.fill(text)
    await this.#take(asked, text)
  }

  /** Answer the file dialog on show, VS Code's own, with `path`. */
  async dialog(path: string): Promise<void> {
    const { input } = this.#prompt()
    // The dialog opens on the folder it starts in; a picker still closing holds other text.
    await until(
      async () => /[\\/]/.test(await input.inputValue().catch(() => '')),
      'the file dialog',
    )
    const asked = await this.#asked()
    await input.fill(path)
    await this.#take(asked, path)
  }

  /** Wait for the Settings editor to search for `query`, then close it. */
  async settings(query: RegExp): Promise<void> {
    const search = this.page.locator('.settings-editor .search-container .view-lines')
    await until(
      async () => query.test(await search.innerText().catch(() => '')),
      'Settings searching ' + query,
    )
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await search.waitFor({ state: 'detached' })
  }

  /** The name of the bottom panel's view on show. */
  async panelShown(): Promise<string> {
    return (
      await this.page
        .locator('.part.panel .composite-bar .action-item.checked')
        .first()
        .innerText()
        .catch(() => '')
    ).trim()
  }

  /**
   * Choose `item` from the popup VS Code opens when `open` runs, as the user does, until `done`
   * holds, and say what the popup offered. Only the Native menus suite goes through VS Code's own
   * popups: VS Code may drop the click that opens one, or close one unasked, so the whole gesture
   * starts over until it takes, which only an item that does the same each time allows.
   */
  async native(
    open: () => Promise<unknown>,
    item: string,
    done: () => Promise<boolean> | boolean,
  ): Promise<string[]> {
    await this.#unprobe()
    // The popup's items, not the menu bar's, which are menu items too.
    const items = this.page.locator('.context-view').getByRole('menuitem')
    const entry = items.filter({ hasText: starting(item) }).first()
    let shown: string[] = []
    await again(
      async () => {
        // No popup left from a try before.
        if (await items.first().isVisible()) await this.page.keyboard.press('Escape')
        await open()
        const opened = await entry.waitFor({ state: 'visible', timeout: 5000 }).then(
          () => true,
          () => false,
        )
        if (!opened) return
        // Each item's title, without the keys that run it.
        shown = await items.evaluateAll((all) =>
          all.map((each) =>
            (each.querySelector('.action-label')?.textContent ?? each.textContent ?? '').trim(),
          ),
        )
        // An item hears the click that chooses it only 100 ms after it shows, so the release of
        // the click that opened its menu chooses nothing: a timer that long, set in the same page
        // now, ends after the item's own.
        await this.page.evaluate('new Promise((resolve) => setTimeout(resolve, 100))')
        await entry.click({ timeout: 2000 }).catch(() => {})
      },
      done,
      item + ' chosen from its popup',
    )
    return shown
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
  results(): Promise<SimulationInfo> {
    return (this.#results ??= this.#import())
  }
  async #import(): Promise<SimulationInfo> {
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
    // A prompt a test left asking holds its command open, and would take the next one's keys.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
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

/** Wait for VS Code to show notifications, then clear them. */
export const notified = (label: string) =>
  until(async () => {
    const found = await notifications()
    return found.length ? found : undefined
  }, label)

/** Keep what VS Code showed when `test` failed. */
export async function failed(test: string): Promise<void> {
  await (await started?.catch(() => undefined))?.failed(test)
}

/** Close the run: its report is written, and a page that threw fails it. */
export async function finish(): Promise<void> {
  await (await started?.catch(() => undefined))?.finish()
}
