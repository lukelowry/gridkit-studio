import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
const result = await build({
  entryPoints: ['src/preferences.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const { SETTINGS } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')
)
const path = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(await readFile(path, 'utf8'))
const configurations = Array.isArray(manifest.contributes.configuration)
  ? manifest.contributes.configuration
  : [manifest.contributes.configuration]
const runtime = configurations.find((group) => group.title === 'GridKit Studio') ?? {
  title: 'GridKit Studio',
  properties: {},
}
for (const key of Object.keys(runtime.properties))
  if (/^gridkitStudio\.(network|diagram|monitor|accessibility)\./.test(key))
    delete runtime.properties[key]
const groups = SETTINGS.map((category) => ({
  id: 'gridkitStudio.' + category.id,
  title: 'GridKit Studio: ' + category.label,
  order: ['network', 'diagram', 'monitor', 'accessibility'].indexOf(category.id) + 1,
  properties: Object.fromEntries(
    category.groups.flatMap((group) =>
      group.settings.map((setting) => {
        const property = {
          default: setting.default,
          scope: 'resource',
          markdownDescription:
            [group.label, setting.label].filter(Boolean).join(' — ') +
            (setting.description ? '. ' + setting.description : ''),
        }
        if (setting.kind === 'choice') {
          property.type = typeof setting.default
          property.enum = setting.options.map((option) => option.value)
          property.enumDescriptions = setting.options.map((option) => option.label)
        } else if (setting.kind === 'number') {
          property.type = setting.default === null ? ['number', 'null'] : 'number'
          property.minimum = setting.min
          property.maximum = setting.max
          if (setting.step === 1)
            property.type = setting.default === null ? ['integer', 'null'] : 'integer'
        } else if (setting.kind === 'color') {
          property.type = ['string', 'null']
          property.pattern = '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'
          property.format = 'color-hex'
          property.markdownDescription += '. Null follows the current VS Code theme.'
        } else property.type = setting.kind === 'boolean' ? 'boolean' : 'string'
        return ['gridkitStudio.' + setting.id, property]
      }),
    ),
  ),
}))
manifest.contributes.configuration = [runtime, ...groups]
const text = JSON.stringify(manifest, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(manifest))
    throw new Error('Native settings are stale. Run pnpm settings.')
} else await writeFile(path, text)
console.log(
  groups.reduce((n, group) => n + Object.keys(group.properties).length, 0) +
    ' Lattice settings contribute to native VS Code Settings.',
)
