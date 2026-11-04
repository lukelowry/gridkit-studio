import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { Case } from './case.js'
import { catalog } from './definition.js'
import { recordingOf } from './recording.js'

const source = `{
 "buses": [
  {"class":"Bus","number":42,"name":"Forty-two","params":{"kv":230.000}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0},"mon":["Va"]}
 ],
 "devices":[
  {"class":"Branch","id":"line","ports":{"bus1":42,"bus2":7},"mon":["P1"]}
 ],
 "monitors":[{"file_name":"first.csv","format":"csv"},{"file_name":"out.csv","format":"CSV"},{"file_name":"out.bin","format":"binary"}]
}`

describe("a case's recording", () => {
  it('counts the outputs each type lists, and finds the monitor GridKit writes to', async () => {
    const recording = await recordingOf(await Case.parse(new TextEncoder().encode(source), catalog))
    expect(recording.listed.Bus).toEqual({ Va: 1 })
    // GridKit takes the case's last CSV monitor.
    expect(recording.monitor).toEqual({ file: 'out.csv' })
    const bare = await Case.parse(
      new TextEncoder().encode(source.replace(/,\s*"monitors":\[.*\]/, '')),
      catalog,
    )
    expect((await recordingOf(bare)).monitor).toBeUndefined()
  })

  it('counts what any class lists as recorded, as GridKit records it', async () => {
    const listless = source.replace(/,"mon":\["(Va|P1)"\]/g, '')
    expect(
      (await recordingOf(await Case.parse(new TextEncoder().encode(listless), catalog))).anything,
    ).toBe(false)
    const future = listless.replace(
      '"devices":[',
      '"devices":[{"class":"Future","id":"next","mon":["out"]},',
    )
    expect(
      await recordingOf(await Case.parse(new TextEncoder().encode(future), catalog)),
    ).toMatchObject({
      listed: {},
      anything: true,
    })
  })

  it('finds the file GridKit writes as it does: the last CSV monitor that uses commas', async () => {
    const monitor = async (sinks: string) =>
      (
        await recordingOf(
          await Case.parse(
            new TextEncoder().encode(source.replace(/"monitors":\[.*\]/, sinks)),
            catalog,
          ),
        )
      ).monitor
    const csv = '{"file_name":"out.csv","format":"csv"}'
    const semi = '{"file_name":"semi.csv","format":"csv","delim":";"}'
    expect(await monitor(`"monitors":[${csv},${semi}]`)).toEqual({ file: 'out.csv' })
    // One that names no file leaves it to the solver file's output_file.
    expect(await monitor(`"monitors":[${csv},{"format":"csv"}]`)).toBeUndefined()
  })

  it('counts an element once for an output its list names twice', async () => {
    const twice = source.replace('"mon":["Va"]', '"mon":["Va","Va"]')
    expect(
      (await recordingOf(await Case.parse(new TextEncoder().encode(twice), catalog))).listed.Bus,
    ).toEqual({ Va: 1 })
  })

  it("reads a bus's list in any case, as GridKit does, and a device's as written", async () => {
    // The branch lists P1, which GridKit, matching a device's outputs as written, takes for no p1.
    const text = source.replace('"mon":["Va"]', '"mon":["va"]')
    const kase = await Case.parse(new TextEncoder().encode(text), catalog)
    expect((await recordingOf(kase)).listed).toEqual({ Bus: { Va: 1 } })
  })

  it('counts what a release case lists, as its own file says', async () => {
    const text = await readFile('cases/IEEE39.case.json', 'utf8')
    const json = JSON.parse(text) as {
      devices: { class: string; mon?: string[] }[]
      buses: { mon?: string[] }[]
    }
    const listed: Record<string, Record<string, number>> = {}
    for (const { mon = [] } of json.buses)
      for (const name of mon) (listed.Bus ??= {})[name] = (listed.Bus?.[name] ?? 0) + 1
    for (const { class: type, mon = [] } of json.devices)
      for (const name of mon) (listed[type] ??= {})[name] = (listed[type]?.[name] ?? 0) + 1
    expect(
      (await recordingOf(await Case.parse(new TextEncoder().encode(text), catalog))).listed,
    ).toEqual(listed)
  })
})
