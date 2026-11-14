const decoder = new TextDecoder()
export const text = (bytes: Uint8Array, start = 0, end = bytes.length) =>
  decoder.decode(bytes.subarray(start, end))
export const isAscii = (bytes: Uint8Array) => bytes.every((byte) => byte < 128)
export const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i])
export function concat(a: Uint8Array, b: Uint8Array) {
  const bytes = new Uint8Array(a.length + b.length)
  bytes.set(a)
  bytes.set(b, a.length)
  return bytes
}
export async function* chunks(bytes: readonly Uint8Array[]) {
  yield* bytes
}
