/** Edits a case's `mon` lists in place, leaving every other byte unchanged: GridKit reads numbers
 *  as written, so reserializing the case could turn a real into an integer. */

import { type Node, parseTree } from 'jsonc-parser'

/** A bus or device record: its array, index, type (Bus, or the device class) and `mon` list. */
export interface Listed {
  readonly array: 'buses' | 'devices'
  readonly index: number
  readonly type: string
  readonly mon: readonly string[]
}

const member = (record: Node, name: string) =>
  record.children?.find((property) => property.children?.[0]?.value === name)?.children?.[1]

/** Replaces each record's `mon` list with what `list` returns; `undefined` leaves it unchanged. */
export function withMons(text: string, list: (record: Listed) => readonly string[] | undefined) {
  const edits: { offset: number; length: number; text: string }[] = []
  for (const property of parseTree(text)?.children ?? []) {
    const [key, value] = property.children ?? []
    const array = key?.value
    if ((array !== 'buses' && array !== 'devices') || value?.type !== 'array') continue
    for (const [index, record] of (value.children ?? []).entries()) {
      if (record.type !== 'object') continue
      const mon = member(record, 'mon')
      const replacement = list({
        array,
        index,
        type: array === 'buses' ? 'Bus' : String(member(record, 'class')?.value),
        mon: mon?.type === 'array' ? (mon.children ?? []).map((name) => String(name.value)) : [],
      })
      if (!replacement) continue
      const written = JSON.stringify(replacement)
      edits.push(
        mon
          ? { offset: mon.offset, length: mon.length, text: written }
          : { offset: record.offset + record.length - 1, length: 0, text: `, "mon": ${written}` },
      )
    }
  }
  // Records are visited in file order, so the edits are sorted.
  let made = ''
  let at = 0
  for (const edit of edits) {
    made += text.slice(at, edit.offset) + edit.text
    at = edit.offset + edit.length
  }
  return made + text.slice(at)
}
