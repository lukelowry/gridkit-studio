import { createHash } from './crypto.js'

export interface BigIntStats {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}
export interface FileHandle {
  read(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  write(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>
  stat(options: { bigint: true }): Promise<BigIntStats>
  stat(): Promise<{ size: number }>
  truncate(size?: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}
export function statistics(path: string, size: number, mtime: number, ctime = mtime): BigIntStats {
  return {
    dev: 0n,
    ino: BigInt('0x' + createHash('sha256').update(path).digest('hex').slice(0, 16)),
    size: BigInt(size),
    mtimeNs: BigInt(Math.floor(mtime * 1e6)),
    ctimeNs: BigInt(Math.floor(ctime * 1e6)),
  }
}
/** VS Code providers expose whole-file reads. Keep one snapshot, then release it on close. */
export class Snapshot implements FileHandle {
  constructor(
    private bytes: Uint8Array,
    private readonly metadata: BigIntStats,
  ) {}
  async read(target: Uint8Array, offset: number, length: number, position: number) {
    const slice = this.bytes.subarray(position, position + length)
    target.set(slice, offset)
    return { bytesRead: slice.length }
  }
  async write(): Promise<{ bytesWritten: number }> {
    throw new Error('The file is read-only.')
  }
  async truncate(): Promise<void> {
    throw new Error('The file is read-only.')
  }
  async sync() {}
  async close() {
    this.bytes = new Uint8Array()
  }
  stat(options: { bigint: true }): Promise<BigIntStats>
  stat(): Promise<{ size: number }>
  async stat(options?: { bigint: true }) {
    return options ? this.metadata : { size: Number(this.metadata.size) }
  }
}
