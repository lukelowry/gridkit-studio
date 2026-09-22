import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

import { Parser } from '../src/parser/client.js'
import { caseText } from './support/case.js'
let root: string
let path: string
const parsers: Parser[] = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridkit-parser-'))
  path = join(root, 'worker.cjs')
  await build({
    entryPoints: ['src/parser/worker.ts'],
    outfile: path,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    mainFields: ['module', 'main'],
  })
})
afterEach(() => {
  for (const parser of parsers.splice(0)) parser.dispose()
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})
it('parses in a real worker with lazy columns, exact bytes, and source spans', async () => {
  const parser = new Parser(() => {}, path)
  parsers.push(parser)
  const text = caseText({ buses: [{ number: 13, name: 'North', params: { x: 1.25 } }] })
  const result = await parser.parse(text, new AbortController().signal)
  expect(result.state).toBe('valid')
  if (result.state !== 'valid') throw new Error('Invalid fixture')
  expect(new TextDecoder().decode(await result.case.model.bytes())).toBe(text)
  expect(
    (await result.case.model.load('bus')).columns.find((column) => column.id === 'params.x')
      ?.values[0],
  ).toBe(1.25)
  const span = (await result.source({ classId: 'bus', index: 0 }))!
  expect(text.slice(span.offset, span.offset + span.length)).toContain('North')
  result.dispose()
  await expect(result.source({ classId: 'bus', index: 0 })).rejects.toThrow('no longer current')
})
it('drops queued cancelled parses and reports structured validation failures', async () => {
  const parser = new Parser(() => {}, path)
  parsers.push(parser)
  const active = parser.parse(caseText({}), new AbortController().signal)
  const controller = new AbortController()
  const cancelled = parser.parse(caseText({}), controller.signal)
  const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  const first = await active
  if (first.state === 'valid') first.dispose()
  expect(await parser.parse('{ broken', new AbortController().signal)).toMatchObject({
    state: 'invalid',
    issues: expect.arrayContaining([expect.objectContaining({ syntax: true })]),
  })
})
it('rejects outstanding requests on a crash and recovers with a new worker', async () => {
  const crash = join(root, 'crash.cjs')
  await writeFile(
    crash,
    "require('node:worker_threads').parentPort.once('message', () => { throw new Error('injected parser crash') })",
  )
  const failed = vi.fn()
  const parser = new Parser(failed, crash)
  parsers.push(parser)
  await expect(parser.parse(caseText({}), new AbortController().signal)).rejects.toThrow()
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
  await writeFile(crash, await (await import('node:fs/promises')).readFile(path))
  const next = await parser.parse(caseText({}), new AbortController().signal)
  expect(next.state).toBe('valid')
  if (next.state === 'valid') next.dispose()
})
