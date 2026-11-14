import { outputHandle, readFile } from './files.js'
import { outputPath } from './host.js'

export const cleanLog = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
export async function loadFactory(path: string) {
  const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
  try {
    return (await import(url)).default
  } finally {
    URL.revokeObjectURL(url)
  }
}
export const linkOutput = async (_target: string, _alias: string) => {}
export async function outputFile(path: string) {
  const disk = await (
    await outputHandle(outputPath(path))
  ).createSyncAccessHandle({ mode: 'readwrite-unsafe' })
  let last = 0
  return {
    open(writing: boolean) {
      if (writing) {
        disk.truncate(0)
        disk.flush()
      }
      return 0
    },
    close(_fd: number) {
      disk.flush()
    },
    write(_fd: number, bytes: Uint8Array, offset: number, length: number, at: number) {
      const written = disk.write(bytes.subarray(offset, offset + length), { at })
      if (performance.now() - last > 40) {
        disk.flush()
        last = performance.now()
      }
      return written
    },
    read: (_fd: number, bytes: Uint8Array, offset: number, length: number, at: number) =>
      disk.read(bytes.subarray(offset, offset + length), { at }),
    size: () => disk.getSize(),
    dispose() {
      disk.flush()
      disk.close()
    },
  }
}
