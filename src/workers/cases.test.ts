import { readFile } from 'node:fs/promises'

import { beforeAll, describe, expect, it } from 'vitest'

import type { CaseApi } from '../shared/messages.js'
import { bundle, start } from './rig.js'

let script: string
beforeAll(async () => {
  script = await bundle('cases', 'case-worker')
})

describe('the case worker', () => {
  it('opens, draws and validates a case', async () => {
    const rig = await start<CaseApi>(script)
    try {
      const revision = { uri: 'file:///independent.case.json', version: 1, attachmentId: 'one' }
      const summary = await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one","mon":["Vm"]}]}',
      })
      expect(summary.validation).toBe('pending')
      expect(summary.recording).toEqual({ listed: { Bus: { Vm: 1 } } })
      const rows = await rig.call('rows', {
        ...revision,
        fields: [{ from: 'Bus', select: ['name'] }],
      })
      expect(rows.map(({ kind }) => kind)).toEqual(['rows'])
      expect(await rig.call('validate', revision)).toEqual([])
      await expect(rig.call('validate', { ...revision, attachmentId: 'old' })).rejects.toThrow(
        /document changed/,
      )
      // Runs and results files are the results worker's: nothing here answers for them.
      await expect(rig.call('step' as keyof CaseApi, { results: 'none' } as never)).rejects.toThrow(
        /Nothing answers step/,
      )
    } finally {
      await rig.stop()
    }
  })

  it('rejects stale attachments without releasing a reopened case', async () => {
    const rig = await start<CaseApi>(script)
    try {
      const revision = { uri: 'file:///snapshot.case.json', version: 1, attachmentId: 'first' }
      const text = '{"buses":[{"class":"Bus","number":1,"name":"original"}]}'
      await rig.call('parse', { ...revision, text })
      await rig.call('release', { uri: revision.uri, attachmentId: 'first' })
      const reopened = await rig.call('parse', {
        ...revision,
        attachmentId: 'second',
        text: text.replace('original', 'changed'),
      })
      await rig.call('release', { uri: revision.uri, attachmentId: 'first' })
      const query = { kind: 'rows', from: 'Bus', select: ['name'], ids: true } as const
      expect(await rig.call('query', { ...reopened, query })).toHaveLength(1)
      await expect(rig.call('query', { ...revision, query })).rejects.toThrow(/document changed/)
    } finally {
      await rig.stop()
    }
  })

  it('edits a case through its revisions, and refuses edits to an older one', async () => {
    const rig = await start<CaseApi>(script)
    const { call, stop } = rig
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      await call('parse', { ...revision, text: await readFile('cases/TwoArea.case.json', 'utf8') })
      expect(
        (
          await call('query', {
            ...revision,
            query: { kind: 'rows', from: 'Bus', select: ['name'], limit: 100 },
          })
        ).length,
      ).toBeGreaterThan(0)
      const edits = await call('transact', {
        ...revision,
        mutations: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'Delta Ω' }],
      })
      const delta = await call('parse', {
        ...revision,
        version: 2,
        baseVersion: 1,
        changes: [edits],
      })
      expect(delta.version).toBe(2)
      await expect(
        call('parse', { ...revision, version: 3, baseVersion: 1, changes: [edits] }),
      ).rejects.toThrow(/mirror is stale/)
      // A malformed newer revision keeps the old projection unavailable to stale edits.
      await expect(call('parse', { ...revision, version: 4, text: '{' })).rejects.toThrow()
      await expect(
        call('transact', {
          ...revision,
          mutations: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'stale' }],
        }),
      ).rejects.toThrow(/changed/)
      await call('release', { uri: revision.uri })
      expect(await call('stats', {})).toMatchObject({ cases: 0 })
    } finally {
      await stop()
    }
  })

  it('holds no document a completion alone brought it', async () => {
    const rig = await start<CaseApi>(script)
    try {
      await rig.call('complete', {
        uri: 'file:///typed.case.json',
        version: 1,
        attachmentId: 'typed',
        offset: 2,
        text: '{"',
      })
      expect(await rig.call('stats', {})).toMatchObject({ cases: 0 })
    } finally {
      await rig.stop()
    }
  })

  it('says where in the source a case fails to parse', async () => {
    const rig = await start<CaseApi>(script)
    try {
      const failed = await rig
        .call('parse', { uri: 'file:///broken.case.json', version: 1, text: '{"buses": [' })
        .catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(Error)
      expect(failed).toHaveProperty('offset')
      expect(failed).toHaveProperty('detail')
    } finally {
      await rig.stop()
    }
  })
})
