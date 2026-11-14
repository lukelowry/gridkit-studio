import { URI } from 'vscode-uri'

import { type BigIntStats, type FileHandle, Snapshot, statistics } from '../snapshot.js'
export type { BigIntStats, FileHandle }
import { workspaceCall } from '../workspace.js'
import { basename, dirname, join } from './path.js'

const local = (path: string) => !/^[a-z][\w+.-]*:/i.test(path) || path.startsWith('opfs:')
const missing = (path: string) =>
  Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' })
const parts = (path: string) =>
  (path.startsWith('opfs:') ? URI.parse(path).path : path).split('/').filter(Boolean)
// A terminated worker's file locks can outlive its lifetime lock by a browser I/O task.
async function unlocked<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if ((error as DOMException).name !== 'NoModificationAllowedError' || attempt === 49)
        throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
async function directory(path: string, create = false) {
  let dir = await navigator.storage.getDirectory()
  for (const part of parts(path)) {
    if (part === '.' || part === '..') throw new Error('Invalid storage path.')
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir
}
async function handle(path: string, create = false) {
  try {
    return await (await directory(dirname(path), create)).getFileHandle(basename(path), { create })
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') throw missing(path)
    throw error
  }
}
export const outputHandle = (path: string) => handle(path, true)
class DiskFile implements FileHandle {
  constructor(
    readonly path: string,
    private readonly disk: FileSystemSyncAccessHandle,
  ) {}
  async read(bytes: Uint8Array, offset: number, length: number, position: number) {
    return { bytesRead: this.disk.read(bytes.subarray(offset, offset + length), { at: position }) }
  }
  async write(bytes: Uint8Array, offset: number, length: number, position: number) {
    return {
      bytesWritten: this.disk.write(bytes.subarray(offset, offset + length), { at: position }),
    }
  }
  async truncate(size = 0) {
    this.disk.truncate(size)
  }
  async sync() {
    this.disk.flush()
  }
  async close() {
    this.disk.close()
  }
  stat(options: { bigint: true }): Promise<BigIntStats>
  stat(): Promise<{ size: number }>
  async stat(options?: { bigint: true }): Promise<BigIntStats | { size: number }> {
    const info = statistics(
      this.path,
      this.disk.getSize(),
      (await (await handle(this.path)).getFile()).lastModified,
    )
    return options?.bigint ? info : { ...info, size: Number(info.size) }
  }
}
export async function open(path: string, flags: string): Promise<FileHandle> {
  if (!local(path)) {
    if (flags !== 'r') throw new Error('Workspace writes must be published from staged storage.')
    const metadata = await stat(path, { bigint: true })
    const bytes = await workspaceCall('read', { path })
    return new Snapshot(bytes, metadata)
  }
  const file = await handle(path, flags !== 'r' && flags !== 'r+')
  const disk = await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' })
  if (flags.startsWith('w')) disk.truncate(0)
  return new DiskFile(path, disk)
}
export function stat(path: string, options: { bigint: true }): Promise<BigIntStats>
export function stat(
  path: string,
): Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>
export async function stat(
  path: string,
  options?: { bigint: true },
): Promise<BigIntStats | { size: number; isFile(): boolean; isDirectory(): boolean }> {
  if (!local(path)) {
    const value = await workspaceCall('stat', { path })
    const result = statistics(path, value.size, value.mtime, value.ctime)
    return options?.bigint
      ? result
      : { ...value, isFile: () => value.type === 1, isDirectory: () => value.type === 2 }
  }
  const file = await (await handle(path)).getFile()
  const result = statistics(path, file.size, file.lastModified)
  return options?.bigint
    ? result
    : { ...result, size: file.size, isFile: () => true, isDirectory: () => false }
}
export function readFile(path: string, options: 'utf8'): Promise<string>
export function readFile(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<Uint8Array<ArrayBuffer>>
export async function readFile(path: string, options?: 'utf8' | { signal?: AbortSignal }) {
  const signal = typeof options === 'object' ? options.signal : undefined
  signal?.throwIfAborted()
  const bytes = local(path)
    ? new Uint8Array(await (await (await handle(path)).getFile()).arrayBuffer())
    : await workspaceCall('read', { path }, signal)
  signal?.throwIfAborted()
  return options === 'utf8' ? new TextDecoder().decode(bytes) : bytes
}
export async function writeFile(path: string, value: string | Uint8Array, _options?: unknown) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  if (!local(path)) return workspaceCall('write', { path, bytes })
  const file = await open(path, 'w')
  try {
    for (let at = 0; at < bytes.length;) {
      const { bytesWritten } = await file.write(bytes, at, bytes.length - at, at)
      if (!bytesWritten) throw new Error('Storage write made no progress.')
      at += bytesWritten
    }
    await file.sync()
  } finally {
    await file.close()
  }
}
export async function mkdir(path: string, _options?: unknown) {
  if (!local(path)) return workspaceCall('mkdir', { path })
  await directory(path, true)
}
export async function readdir(path: string): Promise<string[]> {
  if (!local(path)) return (await workspaceCall('list', { path })).map(([name]) => name)
  const names: string[] = []
  for await (const name of (await directory(path)).keys()) names.push(name)
  return names
}
export async function rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
  if (!local(path)) return workspaceCall('remove', { path })
  try {
    const parent = await directory(dirname(path))
    await unlocked(() => parent.removeEntry(basename(path), { recursive: options?.recursive }))
  } catch (error) {
    if (!options?.force || (error as DOMException).name !== 'NotFoundError') throw error
  }
}
export async function rename(from: string, to: string): Promise<void> {
  if (!local(from) || !local(to)) {
    if (!local(from) && !local(to)) return void (await workspaceCall('rename', { from, to }))
    throw new Error('Cannot move files between workspace and private storage.')
  }
  try {
    const file = await handle(from)
    const target = await directory(dirname(to), true)
    await unlocked(() => file.move(target, basename(to)))
  } catch (error) {
    if ((error as DOMException).name !== 'TypeMismatchError') throw error
    await mkdir(to)
    for (const name of await readdir(from)) await rename(join(from, name), join(to, name))
    await rm(from, { recursive: true })
  }
}
