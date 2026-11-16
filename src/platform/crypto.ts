import { sha256 as noble } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const randomUUID = () => crypto.randomUUID()
export const nonce = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

/** The hex SHA-256 of `parts` concatenated, strings as UTF-8. Hashed natively, without copying a
 *  single part. */
export async function sha256(...parts: readonly (string | Uint8Array)[]): Promise<string> {
  const encoded = parts.map((part) =>
    typeof part === 'string' ? new TextEncoder().encode(part) : part,
  )
  let bytes = encoded[0] ?? new Uint8Array()
  if (encoded.length > 1) {
    bytes = new Uint8Array(encoded.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of encoded) {
      bytes.set(part, at)
      at += part.length
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return bytesToHex(new Uint8Array(digest))
}

export function createHash(_algorithm: 'sha256') {
  const hash = noble.create()
  const result = {
    update(bytes: string | Uint8Array) {
      hash.update(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
      return result
    },
    digest(_encoding: 'hex') {
      return bytesToHex(hash.digest())
    },
  }
  return result
}
