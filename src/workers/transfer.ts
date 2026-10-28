/** Only pass newly owned responses: transfer relinquishes every discovered backing buffer. */
export function transferables(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>()
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (item instanceof ArrayBuffer) found.add(item)
    else if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) found.add(item.buffer)
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child)
    } else {
      for (const child of Object.values(item)) visit(child)
    }
  }
  visit(value)
  return [...found]
}
