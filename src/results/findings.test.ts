import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { Evidence } from './findings.js'

it('pages immutable analysis across disk blocks after the source result is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-evidence-'))
  try {
    const evidence = new Evidence(directory)
    const signal = new AbortController().signal
    const rows = Array.from({ length: 600 }, (_, id) => ({ id, name: '東京' }))
    const id = await evidence.put(
      'case',
      { rows, ...{ fingerprint: 'captured', snapshot: { frames: 99 } } },
      signal,
    )
    rows.length = 0
    const page = await evidence.read(id, { offset: 250, limit: 20 }, signal)
    expect(page).toMatchObject({
      total: 600,
      nextOffset: 270,
      summary: { fingerprint: 'captured', snapshot: { frames: 99 } },
    })
    expect(page.rows).toEqual(Array.from({ length: 20 }, (_, n) => ({ id: 250 + n, name: '東京' })))
    expect(await evidence.read(id, { offset: 599 }, signal)).toMatchObject({
      nextOffset: null,
      rows: [{ id: 599, name: '東京' }],
    })
    await evidence.forget('case')
    await expect(evidence.read(id, {}, signal)).rejects.toThrow(/no longer available/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
