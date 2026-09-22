import { applyEdits, type Edit, modify, visit } from 'jsonc-parser'

import { canonicalMonitor, classMonitors } from './classes.js'
import { modelContract } from './contract.js'
import { locate } from './source.js'
import type { Case } from './validate.js'

export const formatting = (text: string) => ({
  formattingOptions: {
    insertSpaces: true,
    tabSize: 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  },
})

export function changeJson(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, formatting(text)))
}
/** GridKit's variant parser requires a real literal, including for integral R/X values. */
export function changeReal(text: string, path: (string | number)[], value: number): string {
  if (!Number.isFinite(value)) throw new Error('Expected a finite real parameter.')
  const edited = changeJson(text, path, value)
  const span = locate(edited, path)
  const literal = String(value)
  return (
    edited.slice(0, span.offset) +
    (/[.eE]/.test(literal) ? literal : literal + '.0') +
    edited.slice(span.offset + span.length)
  )
}

/** One replacement covering only the changed span; untouched JSON remains byte-for-byte intact. */
export function textEdits(before: string, after: string): Edit[] {
  if (before === after) return []
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = before.length
  let nextEnd = after.length
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--
    nextEnd--
  }
  return [{ offset: start, length: end - start, content: after.slice(start, nextEnd) }]
}

/** Preserve JSON token precision while preparing known native parameter and monitor spellings. */
export function nativeCaseEdits(text: string, raw: Case): Edit[] {
  const edits: Edit[] = []
  visit(text, {
    onLiteralValue(value, offset, length, _line, _column, path) {
      const location = path()
      if (location.length !== 4) return
      const [list, index, block, key] = location
      if ((list !== 'devices' && list !== 'buses') || typeof index !== 'number') return
      const element = raw[list][index]
      if (!element) return
      if (block === 'mon' && typeof value === 'string') {
        const name = canonicalMonitor(element.class, value)
        if (name !== value && classMonitors(element.class).includes(name))
          edits.push({ offset, length, content: JSON.stringify(name) })
        return
      }
      if (
        block !== 'params' ||
        typeof key !== 'string' ||
        typeof value !== 'number' ||
        !modelContract(element.class)?.realParameters.includes(key)
      )
        return
      const literal = text.slice(offset, offset + length)
      if (!/[.eE]/.test(literal))
        edits.push({
          offset,
          length,
          content: literal + '.0',
        })
    },
  })
  return edits
}
