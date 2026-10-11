import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { holds, type Manifest, Menus, named } from '../../tests/menus.js'
import { catalog } from '../gridkit/index.js'
import { menuContext } from '../shared/contexts.js'
import { defaults, definitions, validateSettings } from '../shared/preferences.js'
describe('native VS Code contract', () => {
  it('places each command by a clause VS Code reads, and webview menus by keys every view gives', async () => {
    const menus = new Menus(JSON.parse(await readFile('package.json', 'utf8')) as Manifest)
    // Every menu any view opens carries the same keys, whatever it was opened on.
    const given = new Set(
      Object.keys(
        menuContext(
          { schema: catalog.schema, editable: {} },
          { uri: '', version: 0, origin: 'case' },
        ),
      ),
    )
    for (const { place, when } of menus.clauses()) {
      expect(() => holds(when, {}), place + ': ' + when).not.toThrow()
      if (place === 'webview/context')
        for (const key of named(when)) expect(given, `${key} in "${when}"`).toContain(key)
    }
  })
  it('exposes every display setting exactly once with resource scope', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const settings = Object.assign(
      {},
      ...manifest.contributes.configuration.map(
        (group: { properties: object }) => group.properties,
      ),
    )
    for (const definition of definitions) {
      expect(settings['gridkitStudio.' + definition.id]).toMatchObject({
        default: defaults[definition.id as keyof typeof defaults],
        scope: 'resource',
      })
    }
    expect(settings['gridkitStudio.appearance.theme']).toBeUndefined()
    expect(() => validateSettings({ 'network.vertexRadiusPx': NaN })).toThrow()
    expect(() => validateSettings({ 'diagram.fontSizePx': -1 })).toThrow()
    expect(() => validateSettings({ 'monitor.axisColor': 'red' })).toThrow()
  })
  it('keeps scalar settings separate from nested settings', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const keys = manifest.contributes.configuration.flatMap((group: { properties: object }) =>
      Object.keys(group.properties),
    ) as string[]
    for (const key of keys)
      expect(
        keys.filter((other) => other.startsWith(key + '.')),
        key,
      ).toEqual([])
  })
  it('places Monitor and Case in native panels and exposes no compatibility commands', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(
      manifest.contributes.viewsContainers.panel.map((view: { id: string }) => view.id),
    ).toEqual(['gridkitStudio-case', 'gridkitStudio-monitor'])
    expect(
      manifest.contributes.customEditors.map((editor: { viewType: string }) => editor.viewType),
    ).toEqual(['gridkitStudio.network', 'gridkitStudio.diagram'])
    expect(
      manifest.contributes.commands.some(
        (command: { command: string }) => command.command === 'gridkitStudio.chooseConfiguration',
      ),
    ).toBe(false)
    // The side bar holds what the case records and its video; Monitored Signals is a native tree,
    // not a webview.
    expect(manifest.contributes.views.gridkitStudio.map((view: { id: string }) => view.id)).toEqual(
      ['gridkitStudio.signals', 'gridkitStudio.export'],
    )
    expect(
      manifest.contributes.views.gridkitStudio.find(
        (view: { id: string }) => view.id === 'gridkitStudio.signals',
      ).type,
    ).toBeUndefined()
    expect(
      manifest.contributes.customEditors.map(
        (editor: { displayName: string }) => editor.displayName,
      ),
    ).toEqual(['Network', 'Diagram'])
    // GridKit runs only on the solver file a menu was opened on, as a shell runs it.
    for (const command of ['gridkitStudio.runSimulation', 'gridkitStudio.runContingencies']) {
      for (const menu of ['explorer/context', 'editor/context', 'editor/title/context'])
        expect(manifest.contributes.menus[menu]).toContainEqual(
          expect.objectContaining({ command, when: 'resourceFilename =~ /\\.solver\\.json$/i' }),
        )
      expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' })
    }
    expect(manifest.contributes.taskDefinitions).toBeUndefined()
    // Playback lives in the status bar and the Network's projections in the Network, not the title
    // bars; Fit is the canvas editors' own title action.
    const titled = ['view/title', 'editor/title'].flatMap((menu) =>
      manifest.contributes.menus[menu].map((item: { command: string }) => item.command),
    )
    for (const command of ['toggleTimeline', 'nextSample', 'loopTime', 'projection', 'orbit'])
      expect(titled).not.toContain('gridkitStudio.' + command)
    expect(manifest.contributes.menus['editor/title']).toContainEqual(
      expect.objectContaining({ command: 'gridkitStudio.fit', group: 'navigation@1' }),
    )
    // Every command a menu names is contributed.
    const commands = new Set(
      manifest.contributes.commands.map((command: { command: string }) => command.command),
    )
    for (const items of Object.values(manifest.contributes.menus) as { command?: string }[][])
      for (const { command } of items) if (command) expect(commands).toContain(command)
  })
  it('shows notifications from one place, and registers every command through it', async () => {
    const sources = (await readdir('src', { recursive: true }))
      .filter((path) => /\.(ts|svelte)$/.test(path) && !path.endsWith('.test.ts'))
      .map((path) => join('src', path))
    const notifying: string[] = []
    const registering: string[] = []
    for (const path of sources) {
      const text = await readFile(path, 'utf8')
      if (/show(Error|Warning|Information)Message|kind: 'notify'/.test(text)) notifying.push(path)
      if (/commands\.registerCommand/.test(text)) registering.push(path)
    }
    // Sessions.report tells the user why what they asked for failed; the rest shows in the views.
    expect(notifying).toEqual([join('src', 'extension', 'sessions.ts')])
    expect(registering).toEqual([join('src', 'extension', 'sessions.ts')])
  })
  it('targets the clicked field, case and revision for contextual capabilities', () => {
    const schema = catalog.schema
    const summary = { schema, editable: { BusFault: ['ports.control_signal'] } }
    const target = {
      uri: 'file:///a.case.json',
      version: 42,
      origin: 'diagram' as const,
      element: { id: 'BusFault/one', field: 'ports.control_signal' },
    }
    const context = menuContext(summary, target)
    expect(context.gridkitTarget).toEqual(target)
    expect(context.gridkitEditable).toBe(true)
    expect(context.gridkitReference).toBe(true)
    expect(context.gridkitNetwork).toBe(false)
    expect(context.gridkitDiagram).toBe(true)
  })
})
