import { problem } from '../shared/errors.js'
import type { Mutation, SourceEdit } from '../shared/messages.js'
import type { Case } from './case.js'
import { apply } from './edits.js'
import { planTransaction } from './plan.js'

/** The source edits that make `mutations`, by row ID; only the records they touch are read. */
export function transaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  if (!Array.isArray(mutations) || !mutations.length)
    throw problem('invalid-input', 'A transaction needs a change.')
  return planTransaction(kase, mutations)
}
/** `text` with each group of edits applied in turn, every group against the text before it. */
export function applyChanges(text: string, changes: readonly (readonly SourceEdit[])[]): string {
  for (const group of changes) text = apply(text, group)
  return text
}

/** How much of a text `length` UTF-16 units long `changes` leave as it was, each group of them made
 *  against the text the one before made: its first `prefix` units, and its last `suffix`. Known from
 *  the changes alone, without comparing a text to another. */
export function unchangedBy(
  length: number,
  changes: readonly (readonly SourceEdit[])[],
): { readonly prefix: number; readonly suffix: number } {
  let prefix = length
  let suffix = length
  let current = length
  for (const group of changes) {
    for (const edit of group) {
      prefix = Math.min(prefix, edit.offset)
      suffix = Math.min(suffix, current - edit.offset - edit.length)
    }
    current += group.reduce((grown, edit) => grown + edit.text.length - edit.length, 0)
  }
  return { prefix, suffix }
}

/** A line break, as VS Code counts one. */
const BREAK = /[\r\n]/
/** How many edits of a document VS Code makes one by one: from this many on, it makes them one
 *  edit, from the first to the last, that writes every line between. */
const ONE_BY_ONE = 1000

/** `edits` of `text` as VS Code takes them in least time. VS Code's copy of a document in the
 *  extension host moves every line below an edit for each line the edit writes, and once more if
 *  it takes lines away, so a case of a million lines rewritten in many places stalls every
 *  extension for minutes. Such edits go as one instead, from the first edit to the end of the
 *  text, below which there is nothing to move: two or more that write or take away lines, or as
 *  many as VS Code would make one. Fewer, within lines, go as they are. */
export function delivered(text: string, edits: readonly SourceEdit[]): SourceEdit[] {
  const sorted = [...edits].sort((a, b) => a.offset - b.offset)
  const lines = sorted.filter(
    (edit) =>
      BREAK.test(edit.text) || BREAK.test(text.slice(edit.offset, edit.offset + edit.length)),
  )
  if (lines.length < 2 && sorted.length < ONE_BY_ONE) return sorted
  const from = sorted[0]!.offset
  return [{ offset: from, length: text.length - from, text: apply(text, sorted).slice(from) }]
}
