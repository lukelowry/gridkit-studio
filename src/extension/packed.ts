/** The most buffers a webview message can carry. VS Code counts a message's arguments (handle,
 *  text, one per buffer) in a byte, and buffers past this arrive empty. */
const MESSAGE_BUFFERS = 253

/** Whether `value` is an array or a plain object, which are walked and copied. Anything else, such
 *  as a Map, is passed through unchanged. */
const plain = (value: unknown): value is object =>
  Array.isArray(value) ||
  (!!value &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null))

/** `message`, with its typed arrays copied into one shared buffer when it has more buffers than a
 *  webview message can carry. */
export function packed<T>(message: T): T {
  const buffers = new Set<ArrayBufferLike>()
  const offsets = new Map<ArrayBufferView, number>()
  let bytes = 0
  const find = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) {
      buffers.add(value.buffer)
      if (offsets.has(value)) return
      offsets.set(value, bytes)
      // Align every view to 8 bytes, as Float64Array and BigInt64Array require.
      bytes += Math.ceil(value.byteLength / 8) * 8
    } else if (plain(value)) for (const item of Object.values(value)) find(item)
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
    if (plain(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
    return value
  }
  return copy(message) as T
}
