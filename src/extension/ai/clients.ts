/** Loaded only by client setup and connection diagnostics. */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { type AST, getStaticTOMLValue, parseForESLint } from 'toml-eslint-parser'

import { message } from '../../shared/format.js'

export interface Launch {
  command: string
  args: string[]
  env: Record<string, string>
}

const toml = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']'
  if (value && typeof value === 'object')
    return (
      '{ ' +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + ' = ' + toml(v))
        .join(', ') +
      ' }'
    )
  return JSON.stringify(value)
}
const keysOf = (key: AST.TOMLKey) =>
  key.keys.map((key) => (key.type === 'TOMLBare' ? key.name : key.value))
const prefix = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length <= b.length && a.every((key, n) => key === b[n])

/** Connection repair keeps client-owned tool restrictions and timeouts. */
function configured(previous: unknown, launch: Launch) {
  const source =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {}
  const kept = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        ![
          'url',
          'headers',
          'http_headers',
          'env_http_headers',
          'bearer_token_env_var',
          'type',
        ].includes(key),
    ),
  )
  const env =
    source.env && typeof source.env === 'object' && !Array.isArray(source.env) ? source.env : {}
  return { ...kept, ...launch, env: { ...env, ...launch.env } }
}

/** Replace only GridKit's configuration, preserving other servers, comments and multiline strings. */
export function clientConfig(client: 'codex' | 'claude', source: string, launch: Launch) {
  if (client === 'claude') {
    const errors: ParseError[] = []
    const value = source.trim() ? parse(source, errors) : {}
    if (
      errors.length ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.mcpServers !== undefined &&
        (!value.mcpServers ||
          typeof value.mcpServers !== 'object' ||
          Array.isArray(value.mcpServers)))
    )
      throw new Error('Fix the JSON in .mcp.json before connecting Claude Code.')
    return applyEdits(
      source || '{}',
      modify(
        source || '{}',
        ['mcpServers', 'gridkit'],
        { ...configured(value.mcpServers?.gridkit, launch), type: 'stdio' },
        {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: source.includes('\r\n') ? '\r\n' : '\n',
          },
        },
      ),
    )
  }
  const ast = parseForESLint(source).ast
  const target = ['mcp_servers', 'gridkit']
  const edits: { offset: number; length: number; content: string }[] = []
  let inserted = false
  const previous = getStaticTOMLValue(ast) as { mcp_servers?: { gridkit?: unknown } }
  const value = { ...configured(previous.mcp_servers?.gridkit, launch), enabled: true }
  const visit = (entry: AST.TOMLKeyValue, parent: (string | number)[]) => {
    const path = [...parent, ...keysOf(entry.key)]
    if (prefix(target, path)) {
      if (path.length === target.length) {
        edits.push({
          offset: entry.value.range[0],
          length: entry.value.range[1] - entry.value.range[0],
          content: toml(value),
        })
        inserted = true
      } else
        edits.push({ offset: entry.range[0], length: entry.range[1] - entry.range[0], content: '' })
    } else if (prefix(path, target)) {
      if (entry.value.type !== 'TOMLInlineTable')
        throw new Error('mcp_servers must be a TOML table.')
      const before = edits.length
      for (const child of entry.value.body) visit(child, path)
      if (edits.length === before) {
        edits.push({
          offset: entry.value.range[1] - 1,
          length: 0,
          content:
            (entry.value.body.length ? ', ' : '') +
            target.slice(path.length).map(toml).join('.') +
            ' = ' +
            toml(value) +
            ' ',
        })
        inserted = true
      }
    }
  }
  for (const entry of ast.body[0].body) {
    if (entry.type === 'TOMLKeyValue') visit(entry, [])
    else if (prefix(target, entry.resolvedKey))
      edits.push({ offset: entry.range[0], length: entry.range[1] - entry.range[0], content: '' })
    else for (const child of entry.body) visit(child, entry.resolvedKey)
  }
  let result = applyEdits(source, edits)
  if (!inserted) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n'
    result =
      result.trimEnd() +
      eol +
      eol +
      '[mcp_servers.gridkit]' +
      eol +
      Object.entries(value)
        .map(([k, v]) => k + ' = ' + toml(v))
        .join(eol) +
      eol
  }
  // Never save invalid TOML, including unusual dotted or sealed inline table configurations.
  parseForESLint(result)
  return result
}

/** Exercise the actual launcher, authentication, handshake, schemas and one harmless tool call. */
export async function testConnection(launch: Launch, signal: AbortSignal) {
  const transport = new StdioClientTransport({ ...launch, stderr: 'pipe' })
  const client = new Client({ name: 'gridkit-connection-test', version: '1' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096)
  })
  const abort = () => {
    void client.close()
  }
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await client.connect(transport)
    signal.throwIfAborted()
    const tools = await client.listTools({}, { signal })
    const result = await client.callTool(
      { name: 'gridkit_list_cases', arguments: { limit: 1 } },
      { signal },
    )
    if (result.isError) throw new Error('The relay connected but GridKit could not inspect cases.')
    return { tools: tools.tools.length, server: client.getServerVersion() }
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('GridKit connection test failed: ' + (stderr.trim() || message(error)))
  } finally {
    signal.removeEventListener('abort', abort)
    await client.close()
  }
}
