import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LABEL } from '../shared/document.js'
import { Case } from './case.js'
import { catalog } from './definition.js'
import { diagnose } from './issues.js'

describe('the cases in cases/', () => {
  it.each(readdirSync('cases').filter((name) => name.endsWith('.case.json')))(
    '%s parses whole',
    async (name) => {
      const kase = await Case.parse(await readFile(join('cases', name)), catalog)
      // Every class and member is known to the catalog.
      expect(await diagnose(kase, AbortSignal.any([]))).toEqual([])
      // Each table lists its rows by id, in file order.
      const columns = kase.columns()
      expect(columns.key).toBe(kase.version)
      for (const [type, table] of columns.tables) {
        expect(table.ids.length).toBe(kase.table(type).records.length)
        if (!table.ids.length) continue
        const first = { table: type, id: table.ids[0]! }
        expect(kase.locate(first)?.row).toBe(0)
        expect(table.read(LABEL, 0, 1)).toEqual([String(first.id)])
      }
    },
  )
})
