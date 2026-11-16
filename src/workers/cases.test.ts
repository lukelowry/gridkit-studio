import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { bundle, start } from '../../tests/rig.js'

let script: string
beforeAll(async () => {
  script = await bundle('case-files')
})

/** A worker rig with the URI of case file `name` in its folder, and a function to write it. */
async function rigged(name = 'test.case.json') {
  const rig = await start(script)
  const path = join(rig.scratch, name)
  return {
    ...rig,
    uri: pathToFileURL(path).href,
    write: (text: string | Uint8Array) => writeFile(path, text),
  }
}

const request = { table: 'Bus', fields: ['name'], offset: 0, limit: 100 } as const

describe("the worker's case files", () => {
  it('reads a case file, and draws and validates it', async () => {
    const rig = await rigged()
    try {
      await rig.write(
        JSON.stringify({
          header: { case_name: 'one', case_description: '', case_comments: '' },
          params: { freq_base: 60, va_base: 100e6 },
          buses: [{ class: 'Bus', number: 1, name: 'one', params: {}, mon: ['Vm'] }],
          devices: [],
        }),
      )
      const revision = { uri: rig.uri, version: 1 }
      expect(await rig.call('read', revision)).toMatchObject({
        ...revision,
        recording: { listed: { Bus: { Vm: 1 } }, anything: true },
      })
      const rows = await rig.call('page', { revision, request })
      expect(rows.ids).toEqual([1])
      expect(rows.fields.name).toEqual(['one'])
      expect(await rig.call('validate', revision)).toEqual([])
      await expect(rig.call('validate', { ...revision, version: 2 })).rejects.toThrow(/changed/)
    } finally {
      await rig.stop()
    }
  })

  it('reads a file again once it changes, keeping its version while the content is the same', async () => {
    const rig = await rigged()
    try {
      const text = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'
      await rig.write(text)
      const first = await rig.call('read', { uri: rig.uri, version: 1 })
      // Unchanged, the earlier read stands at its version.
      expect((await rig.call('read', { uri: rig.uri, version: 2 })).version).toBe(1)
      // Rewritten unchanged, it keeps its version.
      await rig.write(text)
      expect(await rig.call('read', { uri: rig.uri, version: 3 })).toMatchObject({
        version: 1,
        fingerprint: first.fingerprint,
      })
      // Changed right away to the same length, within one file time step, it is still read again
      // at the requested version, and the earlier version is superseded.
      await rig.write(text.replace('one', 'two'))
      const changed = await rig.call('read', { uri: rig.uri, version: 4 })
      expect(changed.version).toBe(4)
      expect(changed.fingerprint).not.toBe(first.fingerprint)
      const at = (version: number) => ({ revision: { uri: rig.uri, version }, request })
      expect((await rig.call('page', at(4))).fields.name).toEqual(['two'])
      await expect(rig.call('page', at(1))).rejects.toThrow(/changed/)
    } finally {
      await rig.stop()
    }
  })

  it('releases a file’s case, and reads the file again when it is reopened', async () => {
    const rig = await rigged()
    try {
      await rig.write('{"buses":[{"class":"Bus","number":1,"name":"one"}]}')
      await rig.call('read', { uri: rig.uri, version: 1 })
      await rig.call('release', { uri: rig.uri })
      expect(await rig.call('stats', {})).toMatchObject({ cases: 0 })
      await expect(
        rig.call('page', { revision: { uri: rig.uri, version: 1 }, request }),
      ).rejects.toThrow(/changed/)
      expect((await rig.call('read', { uri: rig.uri, version: 2 })).version).toBe(2)
    } finally {
      await rig.stop()
    }
  })

  it('places an element and its field by line and character, as VS Code counts', async () => {
    const rig = await rigged()
    try {
      const lines = [
        '{',
        ' "header": {"case_name": "東京 😀"},',
        ' "buses": [',
        '  {"class":"Bus","number":1,"name":"😀 one","params":{"kv":1.0}}',
        ' ]',
        '}',
      ]
      // A byte order mark, which VS Code leaves out of the text, does not shift positions.
      await rig.write(Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from(lines.join('\n'))]))
      const revision = { uri: rig.uri, version: 1 }
      await rig.call('read', revision)
      const at = lines[3]!.indexOf('1.0')
      expect(
        await rig.call('locate', { ...revision, table: 'Bus', id: 1, field: 'params.kv' }),
      ).toEqual({ start: [3, at], end: [3, at + 3] })
    } finally {
      await rig.stop()
    }
  })

  it('reports where a file fails to parse, by line and character, and when a file is missing', async () => {
    const rig = await rigged()
    try {
      await rig.write('{"buses": [\n')
      const failed = await rig
        .call('read', { uri: rig.uri, version: 1 })
        .catch((error: unknown) => error)
      // The end of the file, before the open array is closed.
      expect(failed).toMatchObject({ code: 'invalid-input', range: { start: [1, 0] } })
      const missing = pathToFileURL(join(rig.scratch, 'missing.case.json')).href
      await expect(rig.call('read', { uri: missing, version: 2 })).rejects.toThrow(
        'missing.case.json is not there.',
      )
    } finally {
      await rig.stop()
    }
  })
})
