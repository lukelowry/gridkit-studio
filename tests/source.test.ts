import { describe, expect, it } from 'vitest'

import { parse as parseCase } from '../src/gridkit/parse.js'
import { CaseError } from '../src/gridkit/validate.js'
const parse = (bytes: Uint8Array) => parseCase(bytes).model
import { indexElements, locate, syntaxIssues } from '../src/gridkit/source.js'
import { caseBytes, caseText } from './support/case.js'

const failure = (value: unknown): CaseError => {
  try {
    parse(caseBytes(value))
  } catch (error) {
    expect(error).toBeInstanceOf(CaseError)
    return error as CaseError
  }
  throw new Error('Expected case validation to fail')
}

describe('case source locations', () => {
  it('locates the exact reference after Unicode text and CRLF newlines', () => {
    const value = {
      header: { case_name: '\u{1f30d}' },
      buses: [{ number: 1 }],
      devices: [{ class: 'Branch', ports: { bus1: 1, bus2: 99 } }],
    }
    const text = caseText(value, 2).replace(/\n/g, '\r\n')
    const error = failure(value)
    expect(error.path).toEqual(['devices', 0, 'ports', 'bus2'])
    const span = locate(text, error.path)
    expect(text.slice(span.offset, span.offset + span.length)).toBe('99')
  })

  it('locates keys containing punctuation and missing properties at their parent', () => {
    const text = '{"extension":{"a.b":[1,2]}}'
    const span = locate(text, ['extension', 'a.b', 1])
    expect(text.slice(span.offset, span.offset + span.length)).toBe('2')
    const parent = locate(text, ['extension', 'missing'])
    expect(text.slice(parent.offset, parent.offset + parent.length)).toBe('{"a.b":[1,2]}')
  })

  it('indexes buses, signals, and interleaved device classes without confusing nested classes', () => {
    const text = caseText({
      buses: [{ number: 7 }],
      signals: [{ signal_id: 3, name: 'signal' }],
      devices: [
        { class: 'Future', id: 'a', extension: { class: 'Wrong' } },
        { class: 'Other', id: 'b' },
        { class: 'Future', id: 'c' },
      ],
    })
    const ranges = indexElements(text)
    const value = (key: string) => {
      const span = ranges.get(key)!
      return JSON.parse(text.slice(span.offset, span.offset + span.length))
    }
    expect(value('bus:0').number).toBe(7)
    expect(value('signal:0').signal_id).toBe(3)
    expect(value('future:1').id).toBe('c')
    expect(value('future:0').id).toBe('a')
    expect(value('other:0').id).toBe('b')
  })

  it.each(['', '{', '{"x":1,}', '{/* comment */"x":1}'])(
    'rejects invalid strict JSON: %s',
    (text) => {
      expect(syntaxIssues(text).length).toBeGreaterThan(0)
    },
  )

  it('reports duplicate IDs and class collisions at their source', () => {
    expect(failure({ buses: [{ number: 1 }, { number: 1 }] }).path).toEqual(['buses', 1, 'number'])
    expect(
      failure({
        devices: [
          { class: 'Future', id: 'x' },
          { class: 'Future', id: 'x' },
        ],
      }).path,
    ).toEqual(['devices', 1, 'id'])
    expect(failure({ devices: [{ class: 'FooBar' }, { class: 'Foo_Bar' }] }).path).toEqual([
      'devices',
      1,
      'class',
    ])
  })

  it('rejects bad coordinates and malformed polyline points', () => {
    expect(failure({ buses: [{ extension: { longitude: 'west' } }] }).path).toEqual([
      'buses',
      0,
      'extension',
      'longitude',
    ])
    expect(failure({ buses: [{ extension: { latitude: 1e100 } }] }).path).toEqual([
      'buses',
      0,
      'extension',
      'latitude',
    ])
    expect(
      failure({
        buses: [{ number: 1 }],
        devices: [{ class: 'Branch', ports: { bus1: 1, bus2: 1 }, extension: { polyline: [[1]] } }],
      }).path,
    ).toEqual(['devices', 0, 'extension', 'polyline', 0])
  })

  it('accepts signal ports but rejects dangling bus anchors', () => {
    expect(() =>
      parse(caseBytes({ devices: [{ class: 'Future', ports: { speed: 99 } }] })),
    ).not.toThrow()
    expect(failure({ devices: [{ class: 'Future', ports: { bus: 99 } }] }).path).toEqual([
      'devices',
      0,
      'ports',
      'bus',
    ])
  })
})
