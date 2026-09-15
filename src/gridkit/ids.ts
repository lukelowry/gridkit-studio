export function classId(input: string): string {
  const out = input
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
  const stable = out || 'unnamed'
  return /^[A-Za-z_]/.test(stable) ? stable : `x_${stable}`
}

function fnv1aText(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function fnv1aBytes(bytes: Uint8Array, seed: number, limit: number): number {
  let hash = seed >>> 0
  const n = Math.min(bytes.byteLength, limit)
  for (let i = 0; i < n; i++) {
    hash ^= bytes[i]!
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// Compatibility ID: hashes the name, first 4 KiB, and byte length.
export function caseId(name: string, bytes: Uint8Array): string {
  let hash = fnv1aText(name, 2166136261)
  hash = fnv1aBytes(bytes, hash, 4096)
  hash ^= bytes.byteLength
  return `gridkit:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
