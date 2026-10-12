import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { Case } from './case.js'
import { rowCount } from './columns.js'
import { catalog } from './definition.js'

/** What a case reads as, all of it, to tell two reads apart: every column of every table, row by
 *  row, with what each row supplies, its records, the layout of its file, what it found, and its
 *  version. How its tables are cut into chunks is its own. */
function readAll(kase: Case) {
  const tables = Object.fromEntries(
    [...kase.tables].map(([type, table]) => {
      const rows = Array.from({ length: rowCount(table.starts) }, (_, row) => row)
      return [
        type,
        {
          records: Array.from(table.records),
          ids: rows.map((row) => kase.native(table, row)),
          fields: Object.fromEntries(
            [...table.fields].map(([name, column]) => [
              name,
              {
                values: rows.map((row) => kase.cell(table, name, row)),
                supplied: column.supplied && rows.map((row) => column.supplied!(row)),
              },
            ]),
          ),
        },
      ]
    }),
  )
  return {
    version: kase.version,
    name: kase.name,
    close: kase.close,
    members: kase.members,
    arrays: Object.fromEntries(
      Object.entries(kase.arrays).map(([name, array]) => [
        name,
        {
          open: array.open,
          close: array.close,
          starts: Array.from(array.starts),
          ends: Array.from(array.ends),
          mons: Array.from(array.mons),
        },
      ]),
    ),
    found: kase.found,
    types: Object.keys(kase.schema.types).sort(),
    tables,
  }
}

/** Numbers that seem random, the same each run. */
function numbers(seed: number) {
  let state = seed
  return (below: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state % below
  }
}

/** The text of record `i` of `array` in `kase`, and where it is: its file is ASCII, so a byte
 *  offset is a character offset. */
function record(kase: Case, text: string, array: 'buses' | 'devices', i: number) {
  const records = kase.arrays[array]!
  const start = records.starts[i]!
  const end = records.ends[i]!
  return { start, end, text: text.slice(start, end) }
}

describe('a case read again from the one before it', () => {
  it('reads as the whole text reads, edit after edit, wherever each edit lands', async () => {
    const original = await readFile('cases/ACTIVSg2000.case.json', 'utf8')
    expect(Buffer.byteLength(original)).toBe(original.length)
    const random = numbers(7)
    let text = original
    let kase = await Case.parse(text, catalog)
    let id = 0
    /** The case's name changed, outside every array. */
    const header = (_: Case, text: string) =>
      text.replace(/"case_name"\s*:\s*"[^"]*"/, `"case_name":"Edited ${id++}"`)
    /** Each edit the text through: one record changed, added or taken away, or many at once. */
    const edits: ((kase: Case, text: string) => string)[] = [
      // A value changed, as typing does.
      (kase, text) => {
        const { start, text: written } = record(
          kase,
          text,
          'devices',
          random(kase.arrays.devices!.starts.length),
        )
        // A digit of a parameter, never of an id.
        const params = written.indexOf('"params"')
        const digit = params < 0 ? -1 : written.slice(params).search(/[0-9]/)
        if (digit < 0) return text
        const at = start + params + digit
        return text.slice(0, at) + String((Number(text[at]) + 1) % 10) + text.slice(at + 1)
      },
      // A member the catalog does not know, added to a bus.
      (kase, text) => {
        const { end } = record(kase, text, 'buses', random(kase.arrays.buses!.starts.length))
        return text.slice(0, end - 1) + `,"note${id++}":"kept"` + text.slice(end - 1)
      },
      // A device copied after itself, under an id of its own.
      (kase, text) => {
        const { end, text: written } = record(
          kase,
          text,
          'devices',
          random(kase.arrays.devices!.starts.length),
        )
        const copy = written.replace(/"id"\s*:\s*"[^"]*"/, `"id":"copy-${id++}"`)
        return copy === written ? text : text.slice(0, end) + ',\n  ' + copy + text.slice(end)
      },
      // A device taken away, with the comma before it.
      (kase, text) => {
        const devices = kase.arrays.devices!
        const i = 1 + random(devices.starts.length - 1)
        return text.slice(0, devices.ends[i - 1]!) + text.slice(devices.ends[i]!)
      },
      // Several devices in a row taken away at once, ranges apart.
      (kase, text) => {
        const devices = kase.arrays.devices!
        const i = 1 + random(devices.starts.length - 1500)
        return text.slice(0, devices.ends[i - 1]!) + text.slice(devices.ends[i + 1000]!)
      },
      // A device of a class the catalog does not know, and back.
      (kase, text) => {
        const { start, text: written } = record(
          kase,
          text,
          'devices',
          random(kase.arrays.devices!.starts.length),
        )
        const unknown = /"class"\s*:\s*"Mystery"/.test(written)
        const next = written.replace(
          /"class"\s*:\s*"[^"]*"/,
          unknown ? '"class":"Branch"' : '"class":"Mystery"',
        )
        return text.slice(0, start) + next + text.slice(start + written.length)
      },
      // A device added first, and one last.
      (kase, text) => {
        const devices = kase.arrays.devices!
        const first = record(kase, text, 'devices', 0)
        const added = first.text.replace(/"id"\s*:\s*"[^"]*"/, `"id":"edge-${id++}"`)
        const last = devices.ends[devices.starts.length - 1]!
        return (
          text.slice(0, first.start) +
          added +
          ',\n  ' +
          text.slice(first.start, last) +
          ',\n  ' +
          added.replace(/"id":"edge-\d+"/, `"id":"edge-${id++}"`) +
          text.slice(last)
        )
      },
      // Space between two records.
      (kase, text) => {
        const devices = kase.arrays.devices!
        const at = devices.ends[random(devices.starts.length - 1)]!
        return text.slice(0, at) + '\n\n' + text.slice(at)
      },
      // The header, outside every array.
      header,
    ]
    for (let step = 0; step < 40; step++) {
      const edit = edits[step % edits.length]!
      const next = edit(kase, text)
      if (next === text) continue
      const revised = await Case.revise(kase, next)
      // An edit among the records keeps what it leaves alone; one of the header reads it all.
      const kept = revised.parts.filter((part) =>
        kase.parts.some((old) => old.parsed === part.parsed),
      )
      if (edit === header) expect(kept).toEqual([])
      else expect(kept.length).toBeGreaterThan(0)
      // Read whole only every few edits, so what ranges kept have yet to decode moves on with them.
      if (step % 5 === 4 || step === 39)
        expect(readAll(revised)).toEqual(readAll(await Case.parse(next, catalog)))
      text = next
      kase = revised
    }
  }, 60_000)

  it('says what is wrong with an edit as reading the whole text says it', async () => {
    const text = await readFile('cases/WECC240.case.json', 'utf8')
    const kase = await Case.parse(text, catalog)
    const devices = kase.arrays.devices!
    for (const broken of [
      // A record cut short.
      text.slice(0, devices.ends[3]! - 1) + text.slice(devices.ends[3]!),
      // A trailing comma before the array ends.
      text.slice(0, devices.ends.at(-1)!) + ',' + text.slice(devices.ends.at(-1)!),
      // An id two devices share.
      text.slice(0, devices.ends[0]!) +
        ',' +
        text.slice(devices.starts[0]!, devices.ends[0]!) +
        text.slice(devices.ends[0]!),
    ]) {
      const whole = await Case.parse(broken, catalog).catch((error: unknown) => error)
      const revised = await Case.revise(kase, broken).catch((error: unknown) => error)
      expect(whole).toBeInstanceOf(Error)
      expect(revised).toMatchObject({
        message: (whole as Error).message,
        offset: (whole as { offset?: number }).offset,
      })
    }
  })
})
