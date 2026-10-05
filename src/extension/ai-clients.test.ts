import { parse } from 'jsonc-parser'
import { getStaticTOMLValue, parseForESLint } from 'toml-eslint-parser'
import { describe, expect, it } from 'vitest'

import { clientConfig } from './ai-clients.js'

const launch = {
  command: 'C:\\Program Files\\Code.exe',
  args: ['C:\\a b\\relay.cjs', '--directory', 'C:\\workspace'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
}
describe('project MCP configuration', () => {
  it.each([
    '# keep me\nmodel = "a"\n[mcp_servers.other]\ncommand="untouched"\n',
    '# keep me\n[mcp_servers.gridkit]\ncommand="old"\n[mcp_servers.gridkit.env]\nOLD="1"\n[mcp_servers.other]\ncommand="untouched"\n',
    '# keep me\n[mcp_servers]\ngridkit={command="old"}\nother={command="untouched"}\n',
    '# keep me\nmcp_servers={other={command="untouched"}}\n',
    '# keep me\nmcp_servers.gridkit.command="old"\nmcp_servers.other.command="untouched"\n',
    '# keep me\nnotes="""\n[mcp_servers.gridkit]\nnot a table\n"""\n[mcp_servers."gridkit"]\ncommand="old"\n[mcp_servers.other]\ncommand="untouched"\n',
  ])('preserves unrelated TOML and updates Windows paths idempotently: %s', (source) => {
    const output = clientConfig('codex', source, launch)
    const parsed = getStaticTOMLValue(parseForESLint(output).ast)
    expect(parsed).toMatchObject({
      mcp_servers: { gridkit: { ...launch, enabled: true }, other: { command: 'untouched' } },
    })
    expect(output).toContain('# keep me')
    expect(clientConfig('codex', output, launch)).toBe(output)
  })
  it('merges Claude project configuration without touching another server or comments', () => {
    const source = '{\n // keep me\n "mcpServers": {"other":{"command":"other"}}\n}'
    const output = clientConfig('claude', source, launch)
    expect(output).toContain('// keep me')
    expect(parse(output)).toMatchObject({
      mcpServers: { other: { command: 'other' }, gridkit: { type: 'stdio', ...launch } },
    })
    expect(output).toContain('"type": "stdio"')
    expect(clientConfig('claude', output, launch)).toBe(output)
    expect(() => clientConfig('claude', '{broken', launch)).toThrow(/Fix the JSON/)
    expect(() => clientConfig('codex', '[broken', launch)).toThrow()
  })
})
