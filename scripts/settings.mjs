/** Writes the display settings of src/shared/preferences.ts into package.json, after the runtime
 *  settings it keeps; `--check` fails where package.json differs instead. */
import { readFile, writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['src/shared/preferences.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const { SETTINGS } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
)
const path = new URL('../package.json', import.meta.url)
const source = await readFile(path, 'utf8')
const manifest = JSON.parse(source)
const runtime = manifest.contributes.configuration.find((group) => group.title === 'GridKit Studio')

/** A setting as package.json declares it. `--check` compares key order too. */
function property(group, setting) {
  const base = {
    default: setting.default,
    scope: 'resource',
    markdownDescription:
      [group.label, setting.label].filter(Boolean).join(' — ') +
      (setting.description ? '. ' + setting.description : ''),
  }
  switch (setting.kind) {
    case 'choice':
      return {
        ...base,
        type: typeof setting.default,
        enum: setting.options.map((option) => option.value),
        enumDescriptions: setting.options.map((option) => option.label),
      }
    case 'number': {
      const type = setting.step === 1 ? 'integer' : 'number'
      return {
        ...base,
        type: setting.default === null ? [type, 'null'] : type,
        minimum: setting.min,
        maximum: setting.max,
      }
    }
    case 'color':
      return {
        ...base,
        markdownDescription:
          base.markdownDescription.replace(/\.?$/, '.') +
          ' Null follows the current VS Code theme.',
        type: ['string', 'null'],
        pattern: '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
        format: 'color-hex',
      }
    default:
      return { ...base, type: setting.kind === 'boolean' ? 'boolean' : 'string' }
  }
}

const groups = SETTINGS.map((category) => ({
  id: 'gridkitStudio.' + category.id,
  title: 'GridKit Studio: ' + category.label,
  order: ['network', 'diagram', 'monitor', 'accessibility'].indexOf(category.id) + 1,
  properties: Object.fromEntries(
    category.groups.flatMap((group) =>
      group.settings.map((setting) => ['gridkitStudio.' + setting.id, property(group, setting)]),
    ),
  ),
}))
manifest.contributes.configuration = [runtime, ...groups]
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(manifest))
    throw new Error('Native settings are stale. Run pnpm settings.')
} else await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
console.log(
  groups.reduce((n, group) => n + Object.keys(group.properties).length, 0) +
    ' display settings contribute to native VS Code Settings.',
)
