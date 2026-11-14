import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { lstat, readlink, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { fileKey } from '../results/store.js'
import { outputPath } from './host.js'

export const cleanLog = stripVTControlCharacters
export const loadFactory = async (path: string) => (await import(pathToFileURL(path).href)).default
export async function linkOutput(target: string, alias: string) {
  target = outputPath(target)
  alias = outputPath(alias)
  if (fileKey(alias) === fileKey(target)) return
  const existing = await lstat(alias).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) {
    if (
      !existing.isSymbolicLink() ||
      fileKey(resolve(dirname(alias), await readlink(alias))) !== fileKey(target)
    )
      throw new Error(`Study output file is not a link to its monitor: ${alias}`)
  } else {
    mkdirSync(dirname(alias), { recursive: true })
    await symlink(target, alias, 'file')
  }
}
export async function outputFile(path: string) {
  path = outputPath(path)
  const handles = new Set<number>()
  return {
    open(writing: boolean) {
      if (writing) mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(path, writing ? 'w+' : 'r')
      handles.add(fd)
      return fd
    },
    close(fd: number) {
      if (handles.delete(fd)) closeSync(fd)
    },
    write: (fd: number, bytes: Uint8Array, offset: number, length: number, at: number) =>
      writeSync(fd, bytes, offset, length, at),
    read: (fd: number, bytes: Uint8Array, offset: number, length: number, at: number) =>
      readSync(fd, bytes, offset, length, at),
    size: () => statSync(path).size,
    dispose() {
      for (const fd of handles) closeSync(fd)
      handles.clear()
    },
  }
}
