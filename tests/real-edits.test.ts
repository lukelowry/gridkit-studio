import { readFileSync } from 'node:fs'

import { applyEdits } from 'jsonc-parser'
import { expect, it } from 'vitest'

import { changeReal, nativeCaseEdits, textEdits } from '../src/gridkit/edit.js'
import { locate } from '../src/gridkit/source.js'
import { validate } from '../src/gridkit/validate.js'
const original = readFileSync('tests/fixtures/solver/two-bus.case.json', 'utf8')
it('formats integer fault literals without changing their value or other case text', () => {
  const at = locate(original, ['devices', 2, 'params', 'R'])
  const text = original.slice(0, at.offset) + '0' + original.slice(at.offset + at.length)
  const raw = validate(JSON.parse(text))
  const formatted = applyEdits(text, nativeCaseEdits(text, raw))
  expect(formatted).toBe(original)
  expect(JSON.parse(formatted)).toEqual(raw)
  expect(nativeCaseEdits(formatted, raw)).toEqual([])
})
it('preserves real literals, precision, negative zero, and unrelated numbers', () => {
  const text = `{
    "devices": [
      {"class":"BusFault", "ports":{"bus":0}, "params":{"R":-0,"X":9007199254740993,"state0":false}},
      {"class":"BusFault", "params":{"R":1e3,"X":0.000000000000000001}},
      {"class":"BusFault", "params":{"R":1.0,"X":1E+3}},
      {"class":"Branch", "params":{"R":0,"X":1}}
    ]
  }`
  const raw = JSON.parse(text)
  const formatted = applyEdits(text, nativeCaseEdits(text, raw))
  expect(formatted).toBe(
    text
      .replace('"R":-0,', '"R":-0.0,')
      .replace('"X":9007199254740993,', '"X":9007199254740993.0,'),
  )
  expect(JSON.parse(formatted)).toEqual(raw)
  expect(nativeCaseEdits(formatted, raw)).toEqual([])
})
it('returns a text edit for the changed span while preserving all surrounding text', () => {
  const text = changeReal(original, ['devices', 2, 'params', 'R'], 1)
  const edits = textEdits(original, text)
  expect(applyEdits(original, edits)).toBe(text)
  expect(edits[0].length).toBeLessThan(original.length / 2)
})

it('repairs native real tokens and known monitor spelling without rewriting unrelated values', () => {
  const text =
    '{"buses":[],"devices":[{"class":"Genrou","params":{"H":3,"D":0,"unknown":1},"mon":["SPEED","unknown"]},{"class":"BusFault","params":{"state0":false}}]}'
  const edited = applyEdits(text, nativeCaseEdits(text, JSON.parse(text)))
  expect(edited).toBe(
    text.replace('"H":3', '"H":3.0').replace('"D":0', '"D":0.0').replace('"SPEED"', '"speed"'),
  )
  expect(nativeCaseEdits(edited, JSON.parse(edited))).toEqual([])
})
