import { type FileHandle, open, rm } from 'node:fs/promises'

import * as vscode from 'vscode'

/** A video the reader chose a place for, written where the encoder says as it is made. */
export class VideoFile {
  #handle?: FileHandle
  /** The bytes of a video bound for a file system that cannot be written in place. */
  #bytes = new Uint8Array(1 << 20)
  #length = 0
  private constructor(readonly uri: vscode.Uri) {}

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
    const file = new VideoFile(uri)
    if (uri.scheme === 'file') file.#handle = await open(uri.fsPath, 'w')
    return file
  }

  async write(position: number, bytes: Uint8Array) {
    if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid video write.')
    if (this.#handle) {
      for (let written = 0; written < bytes.length;) {
        const { bytesWritten } = await this.#handle.write(
          bytes,
          written,
          bytes.length - written,
          position + written,
        )
        written += bytesWritten
      }
      return
    }
    const end = position + bytes.length
    if (end > this.#bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.#bytes.length * 2))
      grown.set(this.#bytes.subarray(0, this.#length))
      this.#bytes = grown
    }
    this.#bytes.set(bytes, position)
    this.#length = Math.max(this.#length, end)
  }

  async close() {
    if (this.#handle) await this.#handle.close()
    else await vscode.workspace.fs.writeFile(this.uri, this.#bytes.subarray(0, this.#length))
  }

  /** Give the export up: a file begun is removed. */
  async abort() {
    if (!this.#handle) return
    await this.#handle.close().catch(() => {})
    await rm(this.uri.fsPath, { force: true })
  }
}
