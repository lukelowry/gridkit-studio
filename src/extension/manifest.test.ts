import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import catalogJson from '../../catalog.json'
import { catalogOf } from '../gridkit/definition.js'
import { menuContext } from '../shared/contexts.js'
import { defaults, definitions, validateSettings } from '../shared/preferences.js'
describe('native VS Code contract', () => {
  it('exposes every display setting exactly once with resource scope', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const settings = Object.assign(
      {},
      ...manifest.contributes.configuration.map(
        (group: { properties: object }) => group.properties,
      ),
    )
    expect(definitions.length).toBe(139)
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
    // The side bar folds the case's panels, Mappings and Export among them.
    expect(manifest.contributes.views.gridkitStudio.map((view: { id: string }) => view.id)).toEqual(
      [
        'gridkitStudio.inspector',
        'gridkitStudio.bindings',
        'gridkitStudio.simulation',
        'gridkitStudio.export',
      ],
    )
    expect(
      manifest.contributes.customEditors.map(
        (editor: { displayName: string }) => editor.displayName,
      ),
    ).toEqual(['Network', 'Diagram'])
    expect(
      manifest.contributes.views.gridkitStudio.find(
        (view: { id: string }) => view.id === 'gridkitStudio.simulation',
      ).name,
    ).toBe('DynamicSimulation')
    // Playback and the camera belong to the views; the title bars carry none of their commands.
    const titled = ['view/title', 'editor/title'].flatMap((menu) =>
      manifest.contributes.menus[menu].map((item: { command: string }) => item.command),
    )
    for (const command of [
      'toggleTimeline',
      'nextSample',
      'loopTime',
      'fit',
      'projection',
      'orbit',
    ])
      expect(titled).not.toContain('gridkitStudio.' + command)
    // Every command a menu names is contributed.
    const commands = new Set(
      manifest.contributes.commands.map((command: { command: string }) => command.command),
    )
    for (const items of Object.values(manifest.contributes.menus) as { command?: string }[][])
      for (const { command } of items) if (command) expect(commands).toContain(command)
  })
  it('targets the clicked field, case and revision for contextual capabilities', () => {
    const schema = catalogOf(JSON.stringify(catalogJson)).schema
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
