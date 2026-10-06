import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { build } from 'esbuild'
import { beforeAll, expect, it } from 'vitest'

const entry = resolve('output/tests/relay.cjs')
interface Outcome {
  code: number | null
  stdout: string
  stderr: string
  elapsed: number
}
interface Launch {
  child: ChildProcessWithoutNullStreams
  done: Promise<Outcome>
}
beforeAll(async () => {
  await build({
    entryPoints: ['src/mcp.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-relay-'))
  const instance = randomUUID()
  const token = 'a'.repeat(64)
  const address =
    process.platform === 'win32' ? `\\\\.\\pipe\\gridkit-${instance}` : join(directory, 'socket')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let authenticated = false
    let greeting = ''
    socket.on('data', (data: Buffer) => {
      if (authenticated) {
        socket.write(data)
        return
      }
      greeting += data.toString()
      if (!greeting.includes('\n')) return
      if (![`connect ${token}\n`, `probe ${token}\n`].includes(greeting)) {
        socket.destroy()
        return
      }
      authenticated = true
      socket.write('OK\n')
    })
  })
  server.listen(address)
  await once(server, 'listening')
  const children: Launch[] = []
  function launch(): Launch {
    const child = spawn(process.execPath, [entry, '--directory', directory], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const started = Date.now()
    const done = new Promise<{
      code: number | null
      stdout: string
      stderr: string
      elapsed: number
    }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        resolve({ code, stdout, stderr, elapsed: Date.now() - started }),
      )
    })
    const launched = { child, done }
    children.push(launched)
    return launched
  }
  const publish = (name = instance, secret = token) =>
    writeFile(
      join(directory, name + '.json'),
      JSON.stringify({ format: 1, address, instance, token: secret }),
    )
  return {
    launch,
    publish,
    token,
    async close() {
      for (const { child } of children) child.kill()
      await Promise.allSettled(children.map(({ done }) => done))
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

it('waits for delayed extension readiness before forwarding any protocol traffic', async () => {
  const f = await fixture()
  try {
    const { child, done } = f.launch()
    child.stdin.write('ping\n')
    await delay(300)
    expect(child.exitCode).toBeNull()
    const received = once(child.stdout, 'data')
    await f.publish()
    expect((await received)[0].toString()).toBe('ping\n')
    child.stdin.end()
    expect(await done).toMatchObject({ code: 0, stdout: 'ping\n', stderr: '' })
  } finally {
    await f.close()
  }
})

it.each(['authentication', 'ambiguous'])(
  'fails %s connections without startup retries or credential output',
  async (reason) => {
    const f = await fixture()
    try {
      await f.publish(undefined, reason === 'authentication' ? 'b'.repeat(64) : f.token)
      if (reason === 'ambiguous') await f.publish(randomUUID())
      const result = await f.launch().done
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(
        reason === 'authentication' ? /authentication failed/ : /Multiple GridKit windows/,
      )
      expect(result.stderr).not.toContain(f.token)
      expect(result.elapsed).toBeLessThan(4000)
    } finally {
      await f.close()
    }
  },
)

it('ends unavailable startup within its deadline with an actionable error', async () => {
  const f = await fixture()
  try {
    const result = await f.launch().done
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/within 5 seconds.*Connect AI Client/)
    expect(result.elapsed).toBeLessThan(7000)
  } finally {
    await f.close()
  }
}, 10000)
