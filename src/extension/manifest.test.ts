import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { holds, type Manifest, Menus, named } from '../../tests/menus.js'
import { catalog } from '../gridkit/index.js'
import {
  commandId,
  COMMANDS,
  CONTEXT_KEYS,
  contextKey,
  PREFIX,
  viewId,
  VIEWS,
} from '../shared/ids.js'
import { menuContext, signalContext } from '../shared/menus.js'
import { validateSettings } from '../shared/settings.js'

/** The context keys VS Code itself sets that Studio's clauses read. */
const VSCODE_KEYS = [
  'view',
  'viewItem',
  'activeCustomEditorId',
  'resourceFilename',
  'isWorkspaceTrusted',
]

describe('the manifest, as the code names it', () => {
  it('names in code exactly the commands, views and context keys the manifest contributes', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const commands = new Set(
      manifest.contributes.commands.map(({ command }: { command: string }) => command),
    )
    expect(commands).toEqual(new Set(COMMANDS.map(commandId)))
    const views = [
      ...manifest.contributes.customEditors.map(({ viewType }: { viewType: string }) => viewType),
      ...Object.values(manifest.contributes.views)
        .flat()
        .map((view) => (view as { id: string }).id),
    ]
    expect(new Set(views)).toEqual(new Set(VIEWS.map(viewId)))
    // Every command a menu names is contributed.
    for (const items of Object.values(manifest.contributes.menus) as { command?: string }[][])
      for (const { command } of items) if (command) expect(commands).toContain(command)
  })
  it('places each command by a clause VS Code reads, of keys something sets', async () => {
    const menus = new Menus(JSON.parse(await readFile('package.json', 'utf8')) as Manifest)
    // Every menu any view opens carries the same keys, whatever it was opened on.
    const given = new Set(
      Object.keys(
        menuContext({ definition: catalog.definition }, { uri: '', version: 0, origin: 'case' }),
      ),
    )
    // Elsewhere a clause reads the keys Studio sets, and VS Code's own.
    const set = new Set([...CONTEXT_KEYS.map(contextKey), ...VSCODE_KEYS])
    for (const { place, when } of menus.clauses()) {
      expect(() => holds(when, {}), place + ': ' + when).not.toThrow()
      const known = place === 'webview/context' ? given : set
      for (const key of named(when)) expect(known, `${key} in "${when}"`).toContain(key)
    }
  })
  it('matches a Monitored Signals row by the words its context can hold', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const words = signalContext({ recorded: true, mappable: true, mapped: true }).split(' ')
    for (const { when } of manifest.contributes.menus['view/item/context'] as { when: string }[])
      for (const [, word] of when.matchAll(/viewItem =~ \/\\b(\w+)\\b\//g))
        expect(words, when).toContain(word)
  })
  it('takes only the values of a view setting’s kind and range', () => {
    expect(validateSettings({ 'network.vertexRadius': 4 })).toEqual({ 'network.vertexRadius': 4 })
    expect(() => validateSettings({ 'network.vertexRadius': NaN })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.tilt': 2.5 })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.colormap': 'red' })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.map.groundColor': 'red' })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.unknown': 1 })).toThrow('Unknown setting')
    // How GridKit runs is the machine's to set, never a view's.
    expect(() => validateSettings({ gridkitPath: '/opt/gridkit' })).toThrow('Unknown setting')
  })
  it('keeps scalar settings separate from nested settings', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const keys = manifest.contributes.configuration.flatMap((group: { properties: object }) =>
      Object.keys(group.properties),
    ) as string[]
    for (const key of keys) {
      expect(key.startsWith(PREFIX + '.')).toBe(true)
      expect(
        keys.filter((other) => other.startsWith(key + '.')),
        key,
      ).toEqual([])
    }
  })
  it('runs GridKit only on the solver file a menu was opened on, as a shell runs it', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const command = commandId('runSimulation')
    for (const menu of ['explorer/context', 'editor/context', 'editor/title/context'])
      expect(manifest.contributes.menus[menu]).toContainEqual(
        expect.objectContaining({ command, when: 'resourceFilename =~ /\\.solver\\.json$/i' }),
      )
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' })
  })
  it('targets the clicked field, case and revision for contextual capabilities', () => {
    const summary = { definition: catalog.definition }
    const target = {
      uri: 'file:///a.case.json',
      version: 42,
      origin: 'case' as const,
      element: { table: 'GenClassical', id: 'one' },
      field: { table: 'GenClassical', field: 'ports.pmech' },
    }
    const context = menuContext(summary, target)
    expect(context.gridkitTarget).toEqual(target)
    expect(context.gridkitScope).toBe('value')
    expect(context.gridkitReference).toBe(true)
    // A whole element goes where it refers when its type refers to anything: a branch to its buses,
    // a bus to the signals a signal-voltage bus connects, and a signal nowhere.
    const element = (table: string) =>
      menuContext(summary, {
        ...target,
        origin: 'network',
        field: undefined,
        element: { table, id: 1 },
      }).gridkitReference
    expect(element('Branch')).toBe(true)
    expect(element('Bus')).toBe(true)
    expect(element('Signal')).toBe(false)
    // A numeric field of a type the Network draws can be mapped, and says once it is.
    const kv = { table: 'Bus', field: 'params.kv' }
    const column = { uri: target.uri, version: 42, origin: 'case' as const, field: kv }
    expect(menuContext(summary, column)).toMatchObject({
      gridkitScope: 'column',
      gridkitMappable: true,
      gridkitMapped: false,
    })
    expect(menuContext(summary, column, { vertexColor: kv }).gridkitMapped).toBe(true)
  })
})
