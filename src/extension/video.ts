import { randomUUID } from 'node:crypto'
import { type FileHandle, open, rename, rm } from 'node:fs/promises'

import * as vscode from 'vscode'

/** A video the reader chose a place for, written where the encoder says as it is made. */
export class VideoFile {
  #handle?: FileHandle
  readonly #temporary: vscode.Uri
  #closed = false
  /** The bytes of a video bound for a file system that cannot be written in place. */
  #bytes = new Uint8Array(0)
  #length = 0
  private constructor(readonly uri: vscode.Uri) {
    this.#temporary = uri.with({ path: `${uri.path}.${randomUUID()}.tmp` })
  }

  /** Stage a video beside its destination; the destination changes only after encoding succeeds. */
  static async create(uri: vscode.Uri): Promise<VideoFile> {
    const file = new VideoFile(uri)
    if (uri.scheme === 'file') file.#handle = await open(file.#temporary.fsPath, 'wx')
    return file
  }

  /** Ask where `name` goes, beside `beside`; undefined when the reader chose nowhere. */
  static async choose(
    beside: vscode.Uri,
    name: string,
    format: 'mp4' | 'webm',
  ): Promise<VideoFile | undefined> {
    const uri = await vscode.window.showSaveDialog({
      title: 'Export video',
      defaultUri: vscode.Uri.joinPath(beside, '..', name),
      filters: { [format.toUpperCase() + ' video']: [format] },
    })
    if (!uri) return undefined
    return VideoFile.create(uri)
  }

  async write(position: number, bytes: Uint8Array) {
    if (this.#closed) throw new Error('The video file is closed.')
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(position + bytes.length)
    )
      throw new Error('Invalid video write.')
    if (this.#handle) {
      for (let written = 0; written < bytes.length;) {
        const { bytesWritten } = await this.#handle.write(
          bytes,
          written,
          bytes.length - written,
          position + written,
        )
        if (!bytesWritten) throw new Error('The video file could not be written.')
        written += bytesWritten
      }
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
    if (this.#closed) throw new Error('The video file is closed.')
    this.#closed = true
    if (this.#handle) {
      await this.#handle.close()
      // The temporary file is on the same filesystem, so a failed rename leaves the old video.
      await rename(this.#temporary.fsPath, this.uri.fsPath)
    } else {
      await vscode.workspace.fs.writeFile(this.#temporary, this.#bytes.subarray(0, this.#length))
      await vscode.workspace.fs.rename(this.#temporary, this.uri, { overwrite: true })
    }
    this.#bytes = new Uint8Array(0)
  }

  /** Give the export up; only this export's temporary file is removed. Safe after close or failure. */
  async abort() {
    this.#closed = true
    await this.#handle?.close().catch(() => {})
    this.#bytes = new Uint8Array(0)
    if (this.uri.scheme === 'file') await rm(this.#temporary.fsPath, { force: true })
    else
      await Promise.resolve(vscode.workspace.fs.delete(this.#temporary)).catch((error) => {
        if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error
      })
  }
}
