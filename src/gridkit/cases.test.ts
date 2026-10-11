import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Case } from './case.js'
import { catalog } from './definition.js'
import { diagnose } from './edits.js'

describe('the cases in cases/', () => {
  it.each(readdirSync('cases').filter((name) => name.endsWith('.case.json')))(
    '%s parses whole',
    async (name) => {
      const kase = await Case.parse(await readFile(join('cases', name), 'utf8'), catalog)
      // Every class and member is one the catalog knows.
      expect(diagnose(kase)).toEqual([])
    },
  )
})
