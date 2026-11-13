/** Writes the settings of src/shared/settings.ts into package.json, as VS Code's Settings lists
 *  them; `--check` fails where package.json differs instead. */
import { readFile, writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['src/shared/settings.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const { SETTINGS } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
)
const PREFIX = 'gridkitStudio'
const path = new URL('../package.json', import.meta.url)
const source = await readFile(path, 'utf8')
const manifest = JSON.parse(source)

/** A setting as package.json declares it, `order`th of its category. `--check` compares key order
 *  too. */
function property(setting, order) {
  const base = {
    default: setting.default,
    scope: setting.scope,
    order,
    ...(setting.description && { markdownDescription: setting.description }),
  }
  switch (setting.kind) {
    case 'choice':
      return {
        ...base,
        type: typeof setting.default,
        enum: setting.options.map((option) => option.value),
        enumDescriptions: setting.options.map((option) => option.label),
      }
    case 'number':
      return {
        ...base,
        type: setting.integer ? 'integer' : 'number',
        minimum: setting.min,
        ...(setting.max !== undefined && { maximum: setting.max }),
      }
    case 'color':
      return {
        ...base,
        type: ['string', 'null'],
        pattern: '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
        format: 'color-hex',
      }
    default:
      return { ...base, type: setting.kind === 'boolean' ? 'boolean' : 'string' }
  }
}

/** The settings of each category, in the order they are defined: a view's, which its id starts
 *  with, or GridKit's own. */
const categories = new Map()
for (const [id, setting] of Object.entries(SETTINGS)) {
  const category = id.includes('.') ? id.slice(0, id.indexOf('.')) : ''
  const properties = categories.get(category) ?? {}
  properties[`${PREFIX}.${id}`] = property(setting, Object.keys(properties).length)
  categories.set(category, properties)
}
manifest.contributes.configuration = [...categories].map(([category, properties], order) =>
  category
    ? {
        id: `${PREFIX}.${category}`,
        title: `GridKit Studio: ${category[0].toUpperCase()}${category.slice(1)}`,
        order,
        properties,
      }
    : { title: 'GridKit Studio', properties },
)
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(manifest))
    throw new Error('package.json differs from src/shared/settings.ts. Run pnpm settings.')
} else await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
console.log(Object.keys(SETTINGS).length + ' settings contribute to VS Code Settings.')
