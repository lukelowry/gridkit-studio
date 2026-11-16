import { describe, expect, it } from 'vitest'

import { charsAt, rangeIn } from './offsets.js'

/** `text` as UTF-8 bytes, with each character's byte offset and UTF-16 offset. */
function file(text: string) {
  const encoder = new TextEncoder()
  const starts: { byte: number; chars: number }[] = []
  let byte = 0
  let chars = 0
  for (const character of text) {
    starts.push({ byte, chars })
    byte += encoder.encode(character).length
    chars += character.length
  }
  return { bytes: encoder.encode(text), starts }
}

/** The line and character of UTF-16 offset `chars`, as VS Code counts them. */
function positionOf(text: string, chars: number): [number, number] {
  const before = text.slice(0, chars).split('\n')
  return [before.length - 1, before.at(-1)!.length]
}

describe('places in a case file', () => {
  it('counts UTF-16 units and lines across a file of many checkpoints, as VS Code does', () => {
    // Lines of ASCII and of two-, three- and four-byte characters, long enough to need many
    // checkpoints.
    const lines = Array.from({ length: 4000 }, (_, at) =>
      at % 3 === 0 ? `ascii line ${at}` : at % 3 === 1 ? `é东 ${at} ü` : `😀 ${at} ⚡😀`,
    )
    const text = lines.join('\r\n')
    const { bytes, starts } = file(text)
    for (const { byte, chars } of starts.filter((_, at) => at % 997 === 0)) {
      expect(charsAt(bytes, byte)).toBe(chars)
      expect(rangeIn(bytes, { offset: chars, length: 1 }).start).toEqual(positionOf(text, chars))
    }
    // In an all-ASCII file, each byte is one character.
    const ascii = file(lines.filter((_, at) => at % 3 === 0).join('\n'))
    const last = ascii.starts.at(-1)!
    expect(charsAt(ascii.bytes, last.byte)).toBe(last.byte)
  })
})
