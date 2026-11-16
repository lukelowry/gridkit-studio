import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { contextKeysIn, evaluateWhen, type Manifest, Menus } from '../../tests/menus.js'
import { catalog, definitionsOf } from '../gridkit/definition.js'
import {
  commandId,
  COMMANDS,
  CONTEXT_KEYS,
  contextKey,
  EXTENSION,
  PREFIX,
  viewId,
  VIEWS,
} from '../shared/ids.js'
import { menuContext, targetOf } from '../shared/menus.js'
import { validateSettings } from '../shared/settings.js'

/** A definition covering every class in the bundled catalog. */
const definition = definitionsOf([...catalog.shapes.values()])

/** Context keys set by VS Code that Studio's when clauses read. */
const VSCODE_KEYS = ['view', 'activeCustomEditorId', 'resourceFilename', 'isWorkspaceTrusted']

describe('the manifest', () => {
  it('names in code exactly the commands, views and context keys the manifest contributes', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(EXTENSION).toBe(`${manifest.publisher}.${manifest.name}`)
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
    for (const items of Object.values(manifest.contributes.menus) as { command?: string }[][])
      for (const { command } of items) if (command) expect(commands).toContain(command)
  })
  it('places each command by a when clause VS Code can read, of keys the extension sets', async () => {
    const menus = new Menus(JSON.parse(await readFile('package.json', 'utf8')) as Manifest)
    // Webview menus carry the same keys whatever they were opened on.
    const given = new Set(
      Object.keys(menuContext({ definition }, { uri: '', version: 0, origin: 'case' })),
    )
    // Other clauses read the keys Studio sets and VS Code's own.
    const set = new Set([...CONTEXT_KEYS.map(contextKey), ...VSCODE_KEYS])
    for (const { place, when } of menus.clauses()) {
      expect(() => evaluateWhen(when, {}), place + ': ' + when).not.toThrow()
      const known = place === 'webview/context' ? given : set
      for (const key of contextKeysIn(when)) expect(known, `${key} in "${when}"`).toContain(key)
    }
  })
  it('offers Split on a monitor not shown, and Unsplit on one shown beside others', () => {
    const [vm, va] = [
      { table: 'Bus', field: 'Vm' },
      { table: 'Bus', field: 'Va' },
    ]
    const target = { uri: '', version: 0, origin: 'monitor' as const, field: vm, monitor: vm }
    const keys = (monitors: { table: string; field: string }[]) => {
      const context = menuContext({ definition }, target, { monitors })
      return [
        context['gridkitStudio.scope'],
        context['gridkitStudio.shown'],
        context['gridkitStudio.split'],
      ]
    }
    expect(keys([va])).toEqual(['monitor', false, false])
    expect(keys([vm])).toEqual(['monitor', true, false])
    expect(keys([vm, va])).toEqual(['monitor', true, true])
  })
  it('takes only the values of a view setting’s kind and range', () => {
    expect(validateSettings({ 'network.vertexRadius': 4 })).toEqual({ 'network.vertexRadius': 4 })
    expect(() => validateSettings({ 'network.vertexRadius': NaN })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.tilt': 2.5 })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.colormap': 'red' })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.map.groundColor': 'red' })).toThrow('Invalid value')
    expect(() => validateSettings({ 'network.unknown': 1 })).toThrow('Unknown setting')
    // GridKit's location is a machine setting, never a view setting.
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
    const summary = { definition }
    const target = {
      uri: 'file:///a.case.json',
      version: 42,
      origin: 'case' as const,
      element: { table: 'GenClassical', id: 'one' },
      field: { table: 'GenClassical', field: 'ports.pmech' },
    }
    const context = menuContext(summary, target)
    expect(targetOf(context)).toEqual(target)
    expect(context['gridkitStudio.scope']).toBe('value')
    // An element right-clicked in the Network targets the element alone.
    expect(menuContext(summary, { ...target, origin: 'network', field: undefined })).toMatchObject({
      'gridkitStudio.scope': 'element',
      'gridkitStudio.element': true,
    })
    // A numeric field of a type the Network draws is mappable, and reports whether it is mapped.
    const kv = { table: 'Bus', field: 'params.kv' }
    const column = { uri: target.uri, version: 42, origin: 'case' as const, field: kv }
    expect(menuContext(summary, column)).toMatchObject({
      'gridkitStudio.scope': 'column',
      'gridkitStudio.mappable': true,
      'gridkitStudio.mapped': false,
    })
    expect(
      menuContext(summary, column, { mappings: { vertexColor: kv } })['gridkitStudio.mapped'],
    ).toBe(true)
    // Every key a menu carries is prefixed with Studio's namespace.
    for (const key of Object.keys(context))
      if (key !== 'preventDefaultContextMenuItems') expect(key.startsWith(PREFIX + '.')).toBe(true)
  })
})
