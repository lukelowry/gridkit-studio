/** Generate native tool contributions from the same contract consumed by MCP. */
import { readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['src/shared/tools.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { toolDefinitions } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const path = new URL('../package.json', import.meta.url)
const source = await readFile(path, 'utf8')
const manifest = JSON.parse(source)
manifest.contributes.languageModelTools = toolDefinitions.map(({name, displayName, modelDescription, inputSchema}) => ({name, displayName, modelDescription, inputSchema, canBeReferencedInPrompt: true, toolReferenceName: name.replace('gridkit_', 'gridkit_'), icon: '$(circuit-board)', when: 'isWorkspaceTrusted && !gridkitStudio.mcpChat'}))
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(manifest)) throw new Error('Tool contributions are stale. Execute pnpm tools.')
} else await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
console.log(`${toolDefinitions.length} GridKit tool contracts verified.`)
