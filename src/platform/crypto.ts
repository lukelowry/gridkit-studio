import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const randomUUID = () => crypto.randomUUID()
export const nonce = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

export function createHash(_algorithm: 'sha256') {
  const hash = sha256.create()
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
