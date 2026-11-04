/** A case's `mon` lists written as a user writes them in its file: a record's list changed where it
 *  is, or added before the record's closing brace, and every other byte as it was. GridKit reads a
 *  number as it is written, a real written as an integer otherwise, so a case is never written
 *  again whole. */

import { type Node, parseTree } from 'jsonc-parser'

/** A record and what it lists: its array, its place in it, its type (Bus for any bus, a device's
 *  class), and its `mon` list as written. */
export interface Listed {
  readonly array: 'buses' | 'devices'
  readonly index: number
  readonly type: string
  readonly mon: readonly string[]
}

/** The value of member `name` of the object `record`. */
const member = (record: Node, name: string) =>
  record.children?.find((property) => property.children?.[0]?.value === name)?.children?.[1]

/** `text`, a case, with each record's `mon` list as `list` gives it, or as it was where `list` gives
 *  none. */
export function withMons(text: string, list: (record: Listed) => readonly string[] | undefined) {
  const edits: { offset: number; length: number; text: string }[] = []
  for (const property of parseTree(text)?.children ?? []) {
    const [key, value] = property.children ?? []
    const array = key?.value
    if ((array !== 'buses' && array !== 'devices') || value?.type !== 'array') continue
    for (const [index, record] of (value.children ?? []).entries()) {
      if (record.type !== 'object') continue
      const mon = member(record, 'mon')
      const now = list({
        array,
        index,
        type: array === 'buses' ? 'Bus' : String(member(record, 'class')?.value),
        mon: mon?.type === 'array' ? (mon.children ?? []).map((name) => String(name.value)) : [],
      })
      if (!now) continue
      const written = JSON.stringify(now)
      edits.push(
        mon
          ? { offset: mon.offset, length: mon.length, text: written }
          : { offset: record.offset + record.length - 1, length: 0, text: `, "mon": ${written}` },
      )
    }
  }
  // The records are in file order, so the edits are too.
  let made = ''
  let at = 0
  for (const edit of edits) {
    made += text.slice(at, edit.offset) + edit.text
    at = edit.offset + edit.length
  }
  return made + text.slice(at)
}
