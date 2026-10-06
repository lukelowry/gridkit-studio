import { execFile } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import * as vscode from 'vscode'

import type { Sessions } from '../sessions.js'
import { Access } from './access.js'
import type * as Clients from './clients.js'
import type { createAdapter } from './mcp-server.js'
import type { ToolHandler } from './tools.js'

const execute = promisify(execFile)
type Connection = { format: 1; address: string; token: string; instance: string; pid: number }
type Launch = { command: string; args: string[]; env: Record<string, string> }

/** Private on Unix and Windows: mode bits alone do not restrict a Windows directory. */
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') return chmod(path, 0o700)
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const { stdout } = await execute(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  })
  const sid = stdout.match(/S-1-[\d-]+/)?.[0]
  if (!sid) throw new Error('Cannot identify the current Windows user for the AI connection.')
  await execute(
    join(system, 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q'],
    { windowsHide: true },
  )
}

/** Owns one opt-in endpoint for this window; the SDK is loaded only after authentication. */
export class MCP implements vscode.Disposable {
  readonly #instance = randomUUID()
  readonly #changed = new vscode.EventEmitter<void>()
  readonly #sockets = new Set<Socket>()
  readonly #handles = new Map<Socket, { close(): Promise<void> }>()
  readonly #clients = new Map<Socket, { name: string; version: string }>()
  readonly #registrations: vscode.Disposable[]
  #adapter?: ReturnType<typeof createAdapter>
  #server?: Server
  #connection?: Connection
  #record?: string
  #socketDirectory?: string
  #starting?: Promise<Launch>
  #stopping?: Promise<void>
  #disposed = false
  #epoch = 0
  readonly access: Access

  constructor(
    readonly studio: Sessions,
    readonly tools: readonly ToolHandler[],
  ) {
    const context = studio.context
    this.access = new Access(context)
    this.#registrations = [
      this.#changed,
      studio.command('gridkitStudio.aiAccess', () => this.access.choose()),
      studio.command('gridkitStudio.connectAI', () => this.configure()),
      studio.command('gridkitStudio.connectCodex', () => this.configureProject('codex')),
      studio.command('gridkitStudio.connectClaude', () => this.configureProject('claude')),
      studio.command('gridkitStudio.testAI', () => this.test()),
      studio.command('gridkitStudio.aiStatus', () =>
        this.studio.inform(
          !this.#connection
            ? 'GridKit AI connection is off.'
            : this.#clients.size
              ? 'GridKit connected clients: ' +
                [...this.#clients.values()]
                  .map((client) => client.name + ' ' + client.version)
                  .join(', ')
              : 'GridKit is listening. No AI client has completed the MCP handshake. Restart or reconnect MCP in your AI client.',
        ),
      ),
      studio.command('gridkitStudio.disconnectAI', async () => {
        await context.workspaceState.update('mcp.enabled', false)
        await context.workspaceState.update('mcp.vscode', false)
        await vscode.commands.executeCommand('setContext', 'gridkitStudio.mcpChat', false)
        this.#changed.fire()
        await this.stop()
      }),
      vscode.lm.registerMcpServerDefinitionProvider('gridkitStudio.mcp', {
        onDidChangeMcpServerDefinitions: this.#changed.event,
        provideMcpServerDefinitions: () => {
          if (!context.workspaceState.get('mcp.vscode', false)) return []
          const definition = new vscode.McpStdioServerDefinition('GridKit Studio', process.execPath)
          definition.version = context.extension.packageJSON.version
          return [definition]
        },
        resolveMcpServerDefinition: async (definition, token) => {
          if (token.isCancellationRequested) return undefined
          const launch = await this.start(true)
          if (token.isCancellationRequested) return undefined
          Object.assign(definition, launch, { version: context.extension.packageJSON.version })
          return definition
        },
      }),
    ]
    void vscode.commands.executeCommand(
      'setContext',
      'gridkitStudio.mcpChat',
      context.workspaceState.get('mcp.vscode', false),
    )
    if (context.workspaceState.get('mcp.enabled', false))
      void this.start().catch((error) => studio.report(error))
  }

  get connected() {
    return this.#clients.size > 0
  }

  get listening() {
    return !!this.#connection
  }

  #clientTools(): typeof Clients {
    const context = this.studio.context
    return createRequire(join(context.extensionPath, 'package.json'))(
      context.asAbsolutePath('dist/ai-clients.cjs'),
    ) as typeof Clients
  }

  async test(launch?: Launch) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Testing GridKit AI connection',
        cancellable: true,
      },
      async (_, token) => {
        const controller = new AbortController()
        const subscription = token.onCancellationRequested(() => controller.abort())
        const timeout = setTimeout(
          () => controller.abort(new Error('Connection test timed out.')),
          15000,
        )
        try {
          return await this.#clientTools().testConnection(
            launch ?? (await this.start()),
            controller.signal,
          )
        } finally {
          clearTimeout(timeout)
          subscription.dispose()
        }
      },
    )
    if (!launch)
      void this.studio.inform(
        `GridKit relay verified: ${result.tools} tools available. This test does not connect your AI app; use Connect Codex or Connect Claude Code.`,
      )
    return result
  }

  async configureProject(client: 'codex' | 'claude') {
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before configuring an AI client.')
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) throw new Error('Open a workspace folder before connecting an AI client.')
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder:
              'Project to configure for ' + (client === 'codex' ? 'Codex' : 'Claude Code'),
          })
    if (!folder) return
    if (!(await this.access.configure())) return
    const launch = await this.start()
    await this.test(launch)
    const uri = vscode.Uri.joinPath(
      folder.uri,
      client === 'codex' ? '.codex/config.toml' : '.mcp.json',
    )
    let document: vscode.TextDocument | undefined
    try {
      await vscode.workspace.fs.stat(uri)
      document = await vscode.workspace.openTextDocument(uri)
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error
    }
    if (document?.isDirty)
      throw new Error(
        'Save ' +
          vscode.workspace.asRelativePath(uri) +
          ' before connecting; it has unsaved changes.',
      )
    const content = this.#clientTools().clientConfig(client, document?.getText() ?? '', launch)
    const edit = new vscode.WorkspaceEdit()
    if (document)
      edit.replace(
        uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        content,
      )
    else {
      if (client === 'codex')
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.codex'))
      edit.createFile(uri, { overwrite: false })
      edit.insert(uri, new vscode.Position(0, 0), content)
    }
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error('The client configuration changed. Try connecting again.')
    document = await vscode.workspace.openTextDocument(uri)
    if (!(await document.save()))
      throw new Error('Save the client configuration to finish connecting.')
    await this.studio.context.workspaceState.update('mcp.enabled', true)
    const name = client === 'codex' ? 'Codex' : 'Claude Code'
    const message = `${name} configured; GridKit relay verified. Reconnect MCP or restart ${name} in this project and accept its project trust prompt. Keep this VS Code workspace open.`
    this.studio.inform(message, {
      label: 'Open Configuration',
      invoke: () => vscode.window.showTextDocument(document!, { preview: false }),
    })
  }

  /** The workspace directory is stable across reloads; an exact-window launch is opt-in. */
  async start(exactWindow = false): Promise<Launch> {
    if (this.#disposed) throw new vscode.CancellationError()
    if (this.#stopping) await this.#stopping
    if (this.#disposed) throw new vscode.CancellationError()
    const epoch = this.#epoch
    if (!this.#starting)
      this.#starting = this.#start().finally(() => {
        this.#starting = undefined
      })
    let launch: Launch
    try {
      launch = await this.#starting
    } catch (error) {
      await this.stop()
      throw error
    }
    if (this.#disposed || epoch !== this.#epoch) throw new vscode.CancellationError()
    return exactWindow
      ? { ...launch, args: [launch.args[0]!, '--connection', this.#record!] }
      : launch
  }

  async #start(): Promise<Launch> {
    const context = this.studio.context
    if (!context.storageUri) throw new Error('Open a workspace before connecting an AI client.')
    const directory = join(context.storageUri.fsPath, 'mcp')
    const launcherDirectory = join(context.globalStorageUri.fsPath, 'mcp')
    const launcher = join(launcherDirectory, 'relay.cjs')
    if (!this.#connection) {
      const runtime = await execute(
        process.execPath,
        ['-e', 'process.stdout.write(process.versions.node)'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 1024,
        },
      )
      if (
        Number(runtime.stdout.trim().split('.')[0]) < 22 ||
        !/^\d+\.\d+\.\d+$/.test(runtime.stdout.trim())
      )
        throw new Error('VS Code could not start its Node runtime for the MCP relay.')
      await privateDirectory(directory)
      await privateDirectory(launcherDirectory)
      // Drop records left by a crashed extension host, without probing unrelated endpoints.
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
        const path = join(directory, name)
        try {
          const value = JSON.parse(await readFile(path, 'utf8')) as Connection
          if (!Number.isSafeInteger(value.pid) || value.pid < 1) continue
          try {
            process.kill(value.pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(path, { force: true })
          }
        } catch {
          /* An incomplete or foreign record is never selected by the relay. */
        }
      }
      const temporary = join(launcherDirectory, this.#instance + '.cjs')
      try {
        await copyFile(context.asAbsolutePath('dist/mcp.cjs'), temporary)
        await rename(temporary, launcher)
      } finally {
        await rm(temporary, { force: true })
      }
      if (process.platform !== 'win32') {
        this.#socketDirectory = await mkdtemp(join(tmpdir(), 'gridkit-'))
        await chmod(this.#socketDirectory, 0o700)
      }
      const address =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\gridkit-${this.#instance}`
          : join(this.#socketDirectory!, 'mcp.sock')
      const connection: Connection = {
        format: 1,
        address,
        token: randomBytes(32).toString('hex'),
        instance: this.#instance,
        pid: process.pid,
      }
      this.#server = createServer((socket) => this.#accept(socket, connection))
      await new Promise<void>((resolve, reject) => {
        this.#server!.once('error', reject)
        this.#server!.listen(address, () => {
          this.#server!.off('error', reject)
          resolve()
        })
      })
      this.#server.on('error', (error) => this.studio.report(error))
      this.#record = join(directory, this.#instance + '.json')
      const pending = this.#record + '.tmp'
      await writeFile(pending, JSON.stringify(connection), { mode: 0o600 })
      await rename(pending, this.#record)
      this.#connection = connection
      this.studio.output.info('AI connection enabled for this workspace on a private local socket.')
    }
    return {
      command: process.execPath,
      args: [launcher, '--directory', directory],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }

  #accept(socket: Socket, connection: Connection) {
    if (this.#disposed) {
      socket.destroy()
      return
    }
    this.#sockets.add(socket)
    socket.on('error', () => socket.destroy())
    const timer = setTimeout(() => socket.destroy(), 5000)
    socket.once('close', () => {
      clearTimeout(timer)
      this.#sockets.delete(socket)
      this.#clients.delete(socket)
      void this.#handles
        .get(socket)
        ?.close()
        .catch((error) => this.studio.error(error))
      this.#handles.delete(socket)
    })
    let header = ''
    const authenticate = (chunk: Buffer) => {
      header += chunk.toString('utf8')
      if (header.length > 80) {
        socket.destroy()
        return
      }
      if (!header.includes('\n')) return
      socket.pause()
      socket.off('data', authenticate)
      clearTimeout(timer)
      const match = /^(probe|connect) ([a-f0-9]{64})\n$/.exec(header)
      if (
        !match ||
        !timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(connection.token, 'hex'))
      ) {
        socket.destroy()
        return
      }
      if (match[1] === 'probe') {
        socket.end('OK\n')
        return
      }
      try {
        if (!this.#adapter) {
          const context = this.studio.context
          const module = createRequire(join(context.extensionPath, 'package.json'))(
            context.asAbsolutePath('dist/mcp-server.cjs'),
          ) as { createAdapter: typeof createAdapter }
          this.#adapter = module.createAdapter(
            this.tools.map((tool) => ({
              ...tool,
              run: (input, signal) => {
                this.access.require(tool.capability)
                return tool.run(input, signal)
              },
            })),
            context.extension.packageJSON.contributes.languageModelTools,
            context.extension.packageJSON.version,
            (socket, client) => {
              if (client.name !== 'gridkit-connection-test') this.#clients.set(socket, client)
            },
          )
        }
        const handle = this.#adapter(socket)
        this.#handles.set(socket, handle)
        socket.write('OK\n')
        socket.resume()
      } catch (error) {
        this.studio.report(error)
        socket.destroy()
      }
    }
    socket.on('data', authenticate)
  }

  async configure() {
    const client = await vscode.window.showQuickPick(
      [
        {
          label: 'Codex',
          description: 'Configure this project and verify the connection',
          value: 'codex',
        },
        {
          label: 'Claude Code',
          description: 'Configure this project and verify the connection',
          value: 'claude',
        },
        {
          label: 'Other MCP client',
          description: 'Generate a stdio server configuration',
          value: 'json',
        },
        {
          label: 'VS Code MCP',
          description: 'Optional: GridKit already provides native chat tools',
          value: 'vscode',
        },
      ],
      { title: 'Connect AI client to this GridKit workspace' },
    )
    if (!client) return
    if (client.value === 'codex' || client.value === 'claude')
      return this.configureProject(client.value)
    if (!(await this.access.configure())) return
    const scope =
      client.value === 'vscode'
        ? 'window'
        : await vscode.window
            .showQuickPick(
              [
                {
                  label: 'This workspace',
                  description: 'Reconnects after reload; refuses multiple connected windows',
                  value: 'workspace',
                },
                {
                  label: 'This window only',
                  description:
                    'Use when this workspace is open in multiple windows; regenerate after reload',
                  value: 'window',
                },
              ],
              { title: 'Choose which GridKit window the client can access' },
            )
            .then((choice) => choice?.value)
    if (!scope) return
    const launch = await this.start(scope === 'window')
    await this.studio.context.workspaceState.update('mcp.enabled', true)
    if (client.value === 'vscode') {
      await this.studio.context.workspaceState.update('mcp.vscode', true)
      await vscode.commands.executeCommand('setContext', 'gridkitStudio.mcpChat', true)
      this.#changed.fire()
      await vscode.commands.executeCommand('workbench.mcp.listServer')
      return
    }
    const content = JSON.stringify({ mcpServers: { gridkit: launch } }, null, 2)
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({
        language: 'json',
        content,
      }),
    )
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#epoch++
    this.#stopping = (async () => {
      await this.#starting?.catch(() => {})
      for (const socket of this.#sockets) socket.destroy()
      await Promise.all([...this.#handles.values()].map((handle) => handle.close()))
      this.#handles.clear()
      this.#clients.clear()
      const server = this.#server
      this.#server = undefined
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (this.#record) {
        await rm(this.#record, { force: true })
        await rm(this.#record + '.tmp', { force: true })
      }
      if (this.#socketDirectory) {
        await rm(join(this.#socketDirectory, 'mcp.sock'), { force: true })
        await rmdir(this.#socketDirectory)
      }
      this.#record = undefined
      this.#socketDirectory = undefined
      this.#connection = undefined
      this.#adapter = undefined
    })().finally(() => {
      this.#stopping = undefined
    })
    return this.#stopping
  }

  async dispose() {
    this.#disposed = true
    for (const item of this.#registrations) item.dispose()
    await this.stop()
  }
}
