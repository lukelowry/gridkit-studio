import * as fs from 'node:fs/promises'

import { type BigIntStats, type FileHandle, Snapshot, statistics } from './snapshot.js'
import { workspaceCall } from './workspace.js'
export type { BigIntStats, FileHandle }
const remote = (path: string) => /^[a-z][\w+.-]+:/i.test(path)
export async function open(path: string, flags: string): Promise<FileHandle> {
  if (!remote(path)) return fs.open(path, flags)
  if (flags !== 'r') throw new Error('This workspace provider does not support streaming writes.')
  return new Snapshot(await readFile(path), await stat(path, { bigint: true }))
}
export function stat(path: string, options: { bigint: true }): Promise<BigIntStats>
export function stat(
  path: string,
): Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>
export async function stat(
  path: string,
  options?: { bigint: true },
): Promise<BigIntStats | { size: number; isFile(): boolean; isDirectory(): boolean }> {
  if (!remote(path)) return options ? fs.stat(path, options) : fs.stat(path)
  const info = await workspaceCall('stat', { path })
  return options
    ? statistics(path, info.size, info.mtime, info.ctime)
    : { ...info, isFile: () => info.type === 1, isDirectory: () => info.type === 2 }
}
export function readFile(path: string, options: 'utf8'): Promise<string>
export function readFile(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<Uint8Array<ArrayBuffer>>
export async function readFile(path: string, options?: 'utf8' | { signal?: AbortSignal }) {
  if (!remote(path)) return fs.readFile(path, options ?? null)
  const bytes = await workspaceCall(
    'read',
    { path },
    typeof options === 'object' ? options.signal : undefined,
  )
  return options === 'utf8' ? new TextDecoder().decode(bytes) : bytes
}
export const mkdir = (path: string, options?: { recursive?: boolean }) =>
  remote(path) ? workspaceCall('mkdir', { path }) : fs.mkdir(path, options)
export const readdir = (path: string) =>
  remote(path)
    ? workspaceCall('list', { path }).then((entries) => entries.map(([name]) => name))
    : fs.readdir(path)
export const writeFile = (
  path: string,
  data: string | Uint8Array,
  options?: 'utf8' | { flush: boolean },
) =>
  remote(path)
    ? workspaceCall('write', {
        path,
        bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data,
      })
    : fs.writeFile(path, data, options)
export const rename = (from: string, to: string) =>
  remote(from) ? workspaceCall('rename', { from, to }) : fs.rename(from, to)
export const rm = (path: string, options?: { recursive?: boolean; force?: boolean }) =>
  remote(path) ? workspaceCall('remove', { path, ...options }) : fs.rm(path, options)
