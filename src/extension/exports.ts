import * as vscode from 'vscode'

import { randomUUID } from '../platform/crypto.js'
import { type FileHandle, mkdir, open, readFile, rename, rm } from '../platform/files.js'
import { browser, tmpdir } from '../platform/host.js'
import { dirname, extname, join } from '../platform/path.js'
import { download } from './download.js'
import { reference } from './uris.js'

/** What each export is saved as, by its file's extension. */
const KINDS: Record<string, { title: string; filters: Record<string, string[]> }> = {
  '.mp4': { title: 'Export video', filters: { 'MP4 video': ['mp4'] } },
  '.png': { title: 'Export image', filters: { 'PNG image': ['png'] } },
}

/** Publish through the provider only when the staged file is complete. */
export async function publish(path: string, uri: vscode.Uri): Promise<void> {
  if (browser) await download(path, uri.path.split('/').at(-1))
  else if (uri.scheme === 'file') {
    await rename(path, reference(uri))
    return
  } else {
    const staged = uri.with({ path: uri.path + '.' + randomUUID() + '.tmp' })
    try {
      await vscode.workspace.fs.writeFile(staged, await readFile(path))
      await vscode.workspace.fs.rename(staged, uri, { overwrite: true })
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(staged)).catch(() => {})
    }
  }
  await rm(path, { force: true })
}

/** An exported video or image, written sequentially and published to its destination on close. */
export class ExportFile {
  #handle?: FileHandle
  readonly #temporary: vscode.Uri
  #closed = false
  #aborted = false
  #tail: Promise<void> = Promise.resolve()
  #length = 0
  private constructor(readonly uri: vscode.Uri) {
    this.#temporary =
      !browser && uri.scheme === 'file'
        ? uri.with({ path: `${uri.path}.${randomUUID()}.tmp` })
        : browser
          ? vscode.Uri.from({
              scheme: 'opfs',
              path: `/gridkit/exports/${randomUUID()}-${uri.path.split('/').at(-1)}`,
            })
          : vscode.Uri.file(join(tmpdir(), `gridkit-export-${randomUUID()}.tmp`))
  }

  /** Stage a file beside its destination; the destination changes only after writing succeeds. */
  static async create(uri: vscode.Uri): Promise<ExportFile> {
    const file = new ExportFile(uri)
    await mkdir(dirname(reference(file.#temporary)), { recursive: true })
    file.#handle = await open(reference(file.#temporary), 'wx')
    return file
  }

  /** Ask the user where to save `name`, next to `beside`; undefined if cancelled. */
  static async choose(beside: vscode.Uri, name: string): Promise<ExportFile | undefined> {
    const kind = KINDS[extname(name).toLowerCase()]
    if (!kind) throw new Error(`Studio does not export ${extname(name)} files.`)
    if (browser) return ExportFile.create(vscode.Uri.from({ scheme: 'opfs', path: '/' + name }))
    const uri = await vscode.window.showSaveDialog({
      title: kind.title,
      defaultUri: vscode.Uri.joinPath(beside, '..', name),
      filters: kind.filters,
    })
    if (!uri) return undefined
    return ExportFile.create(uri)
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('The export file is closed.')
    return (this.#tail = this.#tail.then(() => this.#write(bytes)))
  }

  async #write(bytes: Uint8Array) {
    if (this.#aborted) throw new Error('The export was cancelled.')
    // Every write goes after the last: the file is written from its start to its end.
    const position = this.#length
    if (this.#handle) {
      for (let written = 0; written < bytes.length;) {
        const { bytesWritten } = await this.#handle.write(
          bytes,
          written,
          bytes.length - written,
          position + written,
        )
        if (!bytesWritten) throw new Error('The export file could not be written.')
        written += bytesWritten
      }
      this.#length += bytes.length
      return
    }
  }

  async close() {
    if (this.#closed) throw new Error('The export file is closed.')
    this.#closed = true
    await this.#tail
    if (this.#aborted) throw new Error('The export was cancelled.')
    await this.#handle!.sync()
    await this.#handle!.close()
    this.#handle = undefined
    await publish(reference(this.#temporary), this.uri)
  }

  /** Discard the export's temporary file; the destination is untouched. Safe after close or failure. */
  async abort() {
    this.#closed = true
    this.#aborted = true
    await this.#tail.catch(() => {})
    await this.#handle?.close().catch(() => {})
    await rm(reference(this.#temporary), { force: true })
  }
}

/** The files one view's exports write, each by the handle the view was given for it. */
export class ExportFiles {
  readonly #open = new Map<number, ExportFile>()
  #next = 0

  /** Asks the user where to save `name`, next to `beside`: a handle to write it through, or null
   *  when they cancel. */
  async open(beside: vscode.Uri, name: string, signal: AbortSignal): Promise<number | null> {
    const file = await ExportFile.choose(beside, String(name))
    if (!file) return null
    if (signal.aborted) {
      await file.abort()
      signal.throwIfAborted()
    }
    this.#open.set(++this.#next, file)
    return this.#next
  }

  async write(handle: number, bytes: Uint8Array | ArrayBuffer): Promise<void> {
    const chunk = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid export write.')
    const file = this.#open.get(handle)
    if (!file) throw new Error('The export file is closed.')
    return file.write(chunk)
  }

  /** Finishes the file, or with `abort` discards it: the finished file's path. */
  async close(handle: number, abort = false): Promise<string | null> {
    const file = this.#open.get(handle)
    this.#open.delete(handle)
    if (!file) return null
    try {
      await (abort ? file.abort() : file.close())
    } catch (error) {
      await file.abort()
      throw error
    }
    return abort ? null : reference(file.uri)
  }

  /** Asks the user where to save `name`, next to `beside`, and writes `bytes` there whole: the
   *  saved file's path, or null when they cancel. */
  async save(
    beside: vscode.Uri,
    name: string,
    bytes: Uint8Array | ArrayBuffer,
    signal: AbortSignal,
  ): Promise<string | null> {
    const handle = await this.open(beside, name, signal)
    if (handle === null) return null
    try {
      await this.write(handle, bytes)
    } catch (error) {
      await this.close(handle, true)
      throw error
    }
    return this.close(handle)
  }

  /** Discards every file still open. */
  dispose(): void {
    for (const file of this.#open.values()) void file.abort().catch(() => {})
    this.#open.clear()
  }
}
