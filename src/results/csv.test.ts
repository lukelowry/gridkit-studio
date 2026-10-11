import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { csvMessages } from './csv.js'

/** Every number of the rows in `text`, read under a header of `width` columns. */
async function numbers(text: string, width: number): Promise<number[]> {
  const known = Array.from({ length: width }, (_, i) => ({
    name: i ? `c${i}` : 't',
    type: 'float64' as const,
    nullable: i !== 0,
  }))
  const values: number[] = []
  for await (const message of csvMessages(Readable.from([Buffer.from(text)]), known))
    if (message.kind === 'rows') values.push(...message.values.subarray(0, message.length * width))
  return values
}

describe('CSV results', () => {
  it('reads each number exactly as Number does, whatever surrounds it', async () => {
    const tokens = ['1.0485160677316046e+00', ' 1.5 ', '"2"', ' "-3e-2" ', '+.5', '5.', '-0']
    expect(await numbers(`0,${tokens.join(',')}\n`, 1 + tokens.length)).toEqual([
      0,
      ...tokens.map((token) => Number(token.trim().replaceAll('"', ''))),
    ])
    expect(await numbers('0,nan,-inf,Infinity,\n', 5)).toEqual([0, NaN, -Infinity, Infinity, NaN])
  })

  it('rejects the hexadecimal, octal and binary numbers GridKit never writes', async () => {
    for (const token of ['0x10', ' 0o7', '"0b1"'])
      await expect(numbers(`0,${token}\n`, 2)).rejects.toThrow(
        'CSV frame 1, column 2 is not a number.',
      )
  })

  it('reads a character that one chunk ends partway through and the next finishes', async () => {
    const messages = async (...chunks: Uint8Array[]) => {
      const read = []
      for await (const message of csvMessages(Readable.from(chunks))) read.push(message)
      return read
    }
    const bytes = Buffer.from('t,"Bus_é€𝄞_Vm"\n0,1\n')
    for (let split = 0; split <= bytes.length; split++)
      expect((await messages(bytes.subarray(0, split), bytes.subarray(split)))[0]).toMatchObject({
        fields: [{ name: 't' }, { name: 'Bus_é€𝄞_Vm' }],
      })
    await expect(messages(Buffer.from('t,a\n0,1€').subarray(0, -1))).rejects.toThrow(
      'The CSV results end inside a UTF-8 character.',
    )
    await expect(messages(Buffer.from('t,a\n0,'), Buffer.from([0xff, 0x31, 0x0a]))).rejects.toThrow(
      'The CSV results are not valid UTF-8.',
    )
  })
})
