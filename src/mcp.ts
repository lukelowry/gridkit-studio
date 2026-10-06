/** Dependency-free stdio relay. GridKit owns the MCP server and all tool execution. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type Connection = { format: number; address: string; token: string; instance: string }
const transient = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'gridkit-not-ready',
])
const retryable = (error: unknown) => transient.has((error as NodeJS.ErrnoException)?.code ?? '')

async function readConnection(path: string, signal: AbortSignal): Promise<Connection> {
  signal.throwIfAborted()
  if ((await stat(path)).size > 4096) throw new Error('Invalid GridKit connection record.')
  const value = JSON.parse(await readFile(path, { encoding: 'utf8', signal })) as Connection
  if (
    value.format !== 1 ||
    typeof value.address !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !/^[a-f0-9-]{36}$/.test(value.instance)
  )
    throw new Error('Unsupported GridKit connection record. Reconnect from VS Code.')
  if (process.platform === 'win32' && !value.address.startsWith('\\\\.\\pipe\\gridkit-'))
    throw new Error('GridKit requires a local named pipe.')
  return value
}

/** Authentication precedes MCP framing; credentials never appear in stdout or config. */
function open(connection: Connection, signal: AbortSignal, probe = false): Promise<Socket> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = connect(connection.address)
    let response = ''
    const timer = setTimeout(
      () => fail(Object.assign(new Error('GridKit connection timed out.'), { code: 'ETIMEDOUT' })),
      1000,
    )
    const fail = (error: Error) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const closed = () => fail(new Error('GridKit authentication failed. Reconnect from VS Code.'))
    const aborted = () => fail(signal.reason)
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      socket.off('data', data)
      socket.off('error', fail)
      socket.off('close', closed)
    }
    const data = (chunk: Buffer) => {
      response += chunk.toString('utf8')
      if (response.length > 3 || (response.includes('\n') && response !== 'OK\n'))
        return fail(new Error('GridKit authentication failed. Reconnect from VS Code.'))
      if (response === 'OK\n') {
        socket.pause()
        cleanup()
        resolve(socket)
      }
    }
    socket.on('error', fail).on('close', closed).on('data', data)
    signal.addEventListener('abort', aborted, { once: true })
    socket.once('connect', () =>
      socket.write(`${probe ? 'probe' : 'connect'} ${connection.token}\n`),
    )
  })
}

async function discoverAndOpen(option: string, path: string, signal: AbortSignal) {
  let connection: Connection
  if (option === '--connection') connection = await readConnection(path, signal)
  else {
    const files = (await readdir(path)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    const live: Connection[] = []
    const probing = new AbortController()
    const probeSignal = AbortSignal.any([signal, probing.signal])
    let cursor = 0
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, files.length) }, async () => {
          while (cursor < files.length) {
            const name = files[cursor++]!
            try {
              const value = await readConnection(join(path, name), probeSignal)
              const socket = await open(value, probeSignal, true)
              socket.destroy()
              live.push(value)
            } catch (error) {
              probeSignal.throwIfAborted()
              if (!retryable(error)) throw error
            }
          }
        }),
      )
    } finally {
      probing.abort()
    }
    if (!live.length)
      throw Object.assign(new Error('GridKit is starting.'), { code: 'gridkit-not-ready' })
    if (live.length !== 1)
      throw new Error(
        'Multiple GridKit windows are connected for this workspace. Disconnect the others or use the exact-window configuration from Connect AI Client.',
      )
    connection = live[0]!
  }
  return open(connection, signal)
}

async function connectWhenReady(option: string, path: string) {
  const signal = AbortSignal.timeout(5000)
  let pause = 100
  try {
    for (;;) {
      signal.throwIfAborted()
      try {
        return await discoverAndOpen(option, path, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!retryable(error)) throw error
      }
      await delay(pause, undefined, { signal })
      pause = Math.min(pause * 2, 500)
    }
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        'GridKit did not become ready within 5 seconds. Open this workspace in VS Code and choose GridKit Studio: Connect AI Client.',
      )
    throw error
  }
}

async function main() {
  const [option, path, ...extra] = process.argv.slice(2)
  if (!path || extra.length || !['--directory', '--connection'].includes(option ?? ''))
    throw new Error(
      'Use the connection command generated by GridKit Studio: Connect AI Client in VS Code.',
    )
  const socket = await connectWhenReady(option!, path)
  const close = () => {
    process.stdin.unpipe(socket)
    process.stdin.pause()
    socket.destroy()
  }
  socket.on('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
    close()
  })
  socket.on('close', close)
  process.stdin.on('error', close).on('end', close)
  process.stdout.on('error', close)
  process.on('SIGTERM', close).on('SIGINT', close)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
  socket.resume()
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
