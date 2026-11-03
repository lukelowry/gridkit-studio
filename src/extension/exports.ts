import { randomUUID } from 'node:crypto'
import { type FileHandle, open, rename, rm } from 'node:fs/promises'
import { extname } from 'node:path'

import * as vscode from 'vscode'

/** What each export is saved as, by its file's extension. */
const KINDS: Record<string, { title: string; filters: Record<string, string[]> }> = {
  '.mp4': { title: 'Export video', filters: { 'MP4 video': ['mp4'] } },
  '.png': { title: 'Export image', filters: { 'PNG image': ['png'] } },
}

/** An exported video or image, written sequentially and published to its destination on close. */
export class ExportFile {
  #handle?: FileHandle
  readonly #temporary: vscode.Uri
  #closed = false
  #aborted = false
  #tail: Promise<void> = Promise.resolve()
  /** The file in memory, for non-`file` destinations that cannot be written in place. */
  #bytes = new Uint8Array(0)
  #length = 0
  private constructor(readonly uri: vscode.Uri) {
    this.#temporary = uri.with({ path: `${uri.path}.${randomUUID()}.tmp` })
  }

  /** Stage a file beside its destination; the destination changes only after writing succeeds. */
  static async create(uri: vscode.Uri): Promise<ExportFile> {
    const file = new ExportFile(uri)
    if (uri.scheme === 'file') file.#handle = await open(file.#temporary.fsPath, 'wx')
    return file
  }

  /** Ask the user where to save `name`, next to `beside`; undefined if cancelled. */
  static async choose(beside: vscode.Uri, name: string): Promise<ExportFile | undefined> {
    const kind = KINDS[extname(name).toLowerCase()]
    if (!kind) throw new Error(`Studio does not export ${extname(name)} files.`)
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
    const position = this.#length
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(position + bytes.length)
    )
      throw new Error('Invalid export write.')
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
    const end = position + bytes.length
    if (end > this.#bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.#bytes.length * 2, 1 << 20))
      grown.set(this.#bytes.subarray(0, this.#length))
      this.#bytes = grown
    }
    this.#bytes.set(bytes, position)
    this.#length = Math.max(this.#length, end)
  }

  async close() {
    if (this.#closed) throw new Error('The export file is closed.')
    this.#closed = true
    await this.#tail
    if (this.#aborted) throw new Error('The export was cancelled.')
    if (this.#handle) {
      await this.#handle.close()
      // Same file system, so the rename is atomic and a failure leaves the old file.
      await rename(this.#temporary.fsPath, this.uri.fsPath)
    } else {
      await vscode.workspace.fs.writeFile(this.#temporary, this.#bytes.subarray(0, this.#length))
      await vscode.workspace.fs.rename(this.#temporary, this.uri, { overwrite: true })
    }
    this.#bytes = new Uint8Array(0)
  }

  /** Discard the export's temporary file; the destination is untouched. Safe after close or failure. */
  async abort() {
    this.#closed = true
    this.#aborted = true
    await this.#tail.catch(() => {})
    await this.#handle?.close().catch(() => {})
    this.#bytes = new Uint8Array(0)
    if (this.uri.scheme === 'file') await rm(this.#temporary.fsPath, { force: true })
    else
      await Promise.resolve(vscode.workspace.fs.delete(this.#temporary)).catch((error) => {
        if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error
      })
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
    return abort ? null : file.uri.fsPath
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
