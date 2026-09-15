import type { ElementRef } from '@latkit/model'
import { type JSONPath, printParseErrorCode, visit } from 'jsonc-parser'

import { classId } from './ids.js'

export interface Span {
  offset: number
  length: number
}
export interface Issue extends Span {
  message: string
  syntax?: boolean
}
const strict = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false }

export function syntaxIssues(text: string): Issue[] {
  const issues: Issue[] = []
  visit(
    text,
    {
      onError(error, offset, length) {
        const words = printParseErrorCode(error)
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
        issues.push({ offset, length, message: `Invalid JSON: ${words}.`, syntax: true })
      },
    },
    strict,
  )
  return issues
}

// Keep only the closest matching path, rather than retaining a full syntax tree.
export function locate(text: string, path: readonly (string | number)[]): Span {
  let depth = -1
  let best: Span = { offset: 0, length: 0 }
  const frames: Span[] = []
  const match = (offset: number, length: number, at: JSONPath): Span => {
    const span = { offset, length }
    if (
      at.length <= path.length &&
      at.every((key, index) => key === path[index]) &&
      at.length >= depth
    ) {
      depth = at.length
      best = span
    }
    return span
  }
  const begin = (
    offset: number,
    length: number,
    _line: number,
    _column: number,
    path: () => JSONPath,
  ) => {
    frames.push(match(offset, length, path()))
  }
  const end = (offset: number, length: number) => {
    const span = frames.pop()!
    span.length = offset + length - span.offset
  }
  visit(
    text,
    {
      onObjectBegin: begin,
      onArrayBegin: begin,
      onObjectEnd: end,
      onArrayEnd: end,
      onLiteralValue: (_value, offset, length, _line, _column, path) => {
        match(offset, length, path())
      },
    },
    strict,
  )
  return best
}

export const elementKey = (ref: ElementRef): string => `${ref.classId}:${ref.index}`

export function indexElements(text: string): ReadonlyMap<string, Span> {
  const result = new Map<string, Span>()
  const counts = new Map<string, number>()
  const frames: { offset: number; path: JSONPath; property?: string; className?: string }[] = []
  visit(
    text,
    {
      onObjectBegin(offset, _length, _line, _column, path) {
        frames.push({ offset, path: path() })
      },
      onObjectProperty(property) {
        frames.at(-1)!.property = property
      },
      onLiteralValue(value) {
        const frame = frames.at(-1)
        if (frame?.property === 'class' && typeof value === 'string') frame.className = value
      },
      onObjectEnd(offset, length) {
        const frame = frames.pop()!
        if (frame.path.length !== 2 || typeof frame.path[1] !== 'number') return
        let id: string
        let index = frame.path[1]
        if (frame.path[0] === 'buses') id = 'bus'
        else if (frame.path[0] === 'signals') id = 'signal'
        else if (frame.path[0] === 'devices' && frame.className !== undefined) {
          id = classId(frame.className)
          index = counts.get(id) ?? 0
          counts.set(id, index + 1)
        } else return
        result.set(elementKey({ classId: id, index }), {
          offset: frame.offset,
          length: offset + length - frame.offset,
        })
      },
    },
    strict,
  )
  return result
}
