import * as native from 'node:path'
import { fileURLToPath as filePath } from 'node:url'

import * as portable from './browser/path.js'
const remote = (path: string) => /^[a-z][\w+.-]+:/i.test(path)
export const basename = (path: string) =>
  remote(path) ? portable.basename(path) : native.basename(path)
export const dirname = (path: string) =>
  remote(path) ? portable.dirname(path) : native.dirname(path)
export const extname = (path: string) =>
  remote(path) ? portable.extname(path) : native.extname(path)
export const isAbsolute = (path: string) => remote(path) || native.isAbsolute(path)
export const join = (first: string, ...parts: string[]) =>
  remote(first) ? portable.join(first, ...parts) : native.join(first, ...parts)
export const resolve = (first = '.', ...parts: string[]) =>
  remote(first) || parts.some(remote)
    ? portable.resolve(first, ...parts)
    : native.resolve(first, ...parts)
export const fileURLToPath = (path: string) => (path.startsWith('file:') ? filePath(path) : path)
