import { describe, expect, it } from 'vitest'

import { Case, catalog } from './index.js'
import { networkSelectionOf } from './inspection.js'

const signal = new AbortController().signal
describe('case inspection', () => {
  it('selects an element the Network does not draw by the buses it reaches', async () => {
    const kase = await Case.parse(
      new TextEncoder().encode(
        JSON.stringify({
          buses: [
            { class: 'Bus', number: 1 },
            { class: 'Bus', number: 2 },
          ],
          signals: [{ signal_id: 1 }, { signal_id: 2 }],
          devices: [
            { class: 'Branch', id: 'line', ports: { bus1: 1, bus2: 2 } },
            { class: 'GenClassical', id: 'fault', ports: { bus: 2, pmech: 1 } },
            { class: 'ConstantSignalSource', id: 'source', ports: { sr: 1 } },
            { class: 'ConstantSignalSource', id: 'alone', ports: { sr: 2 } },
          ],
        }),
      ),
      catalog,
    )
    const selected = (table: string, id: string | number) =>
      networkSelectionOf(kase, { table, id }, signal)
    // An element the Network draws is selected itself.
    expect(await selected('Bus', 1)).toEqual([{ table: 'Bus', id: 1 }])
    expect(await selected('Branch', 'line')).toEqual([{ table: 'Branch', id: 'line' }])
    // A machine by its bus, and a source by the bus of the machine its signal drives.
    expect(await selected('GenClassical', 'fault')).toEqual([{ table: 'Bus', id: 2 }])
    expect(await selected('ConstantSignalSource', 'source')).toEqual([{ table: 'Bus', id: 2 }])
    // A source whose signal drives nothing selects nothing there.
    expect(await selected('ConstantSignalSource', 'alone')).toEqual([])
    await expect(selected('Bus', 3)).rejects.toThrow(/Unknown element/)
  })
})
