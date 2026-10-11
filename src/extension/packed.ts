/** The most buffers a webview message keeps. VS Code sends one as its handle, its text and one
 *  argument per buffer, and counts the arguments in a byte: buffers past these arrive empty. */
const MESSAGE_BUFFERS = 253

/** `message` as a webview can receive it whole. One that holds more buffers than VS Code sends has
 *  its arrays copied into one buffer, each a view of its own there. */
export function packed<T>(message: T): T {
  const buffers = new Set<ArrayBufferLike>()
  const offsets = new Map<ArrayBufferView, number>()
  let bytes = 0
  const find = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) {
      buffers.add(value.buffer)
      if (offsets.has(value)) return
      offsets.set(value, bytes)
      // Every view starts eight-aligned, as a Float64Array or BigInt64Array must.
      bytes += Math.ceil(value.byteLength / 8) * 8
    } else if (value && typeof value === 'object')
      for (const item of Object.values(value)) find(item)
  }
  find(message)
  if (buffers.size <= MESSAGE_BUFFERS) return message
  const buffer = new ArrayBuffer(bytes)
  const moved = new Map<ArrayBufferView, ArrayBufferView>()
  const copy = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value)) {
      let view = moved.get(value)
      if (!view) {
        const at = offsets.get(value)!
        new Uint8Array(buffer, at, value.byteLength).set(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        )
        const Type = value.constructor as {
          new (buffer: ArrayBuffer, offset: number, length: number): ArrayBufferView
          BYTES_PER_ELEMENT?: number
        }
        view = new Type(buffer, at, value.byteLength / (Type.BYTES_PER_ELEMENT ?? 1))
        moved.set(value, view)
      }
      return view
    }
    if (Array.isArray(value)) return value.map(copy)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
    return value
  }
  return copy(message) as T
}
