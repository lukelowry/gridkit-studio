import * as vscode from 'vscode'

import { useWorkspace } from '../platform/workspace.js'

export function workspaceAccess() {
  useWorkspace(async (method, input, signal) => {
    signal?.throwIfAborted()
    const value = input as { path: string; from: string; to: string; bytes: Uint8Array }
    const fs = vscode.workspace.fs
    const uri = () => vscode.Uri.parse(value.path)
    try {
      let result: unknown
      switch (method) {
        case 'read':
          result = await fs.readFile(uri())
          break
        case 'stat':
          result = await fs.stat(uri())
          break
        case 'list':
          result = await fs.readDirectory(uri())
          break
        case 'write':
          await fs.writeFile(uri(), value.bytes)
          result = null
          break
        case 'mkdir':
          await fs.createDirectory(uri())
          result = null
          break
        case 'rename':
          await fs.rename(vscode.Uri.parse(value.from), vscode.Uri.parse(value.to), {
            overwrite: true,
          })
          result = null
          break
        case 'remove':
          await fs.delete(uri(), { recursive: 'recursive' in input && input.recursive === true })
          result = null
          break
      }
      signal?.throwIfAborted()
      return result as never
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        if (method === 'remove' && 'force' in input && input.force === true) return null as never
        throw Object.assign(new Error(error.message), { code: 'ENOENT' })
      }
      throw error
    }
  })
}
