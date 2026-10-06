import { describe, expect, it } from 'vitest'

import { Case, catalog } from './index.js'
import { anchors } from './inspection.js'

const signal = new AbortController().signal
describe('case inspection', () => {
  it('stands an element the network does not draw in for the buses it reaches', async () => {
    const kase = await Case.parse(
      JSON.stringify({
        buses: [
          { class: 'Bus', number: 1 },
          { class: 'Bus', number: 2 },
        ],
        signals: [{ signal_id: 1 }],
        devices: [
          { class: 'Branch', id: 'line', ports: { bus1: 1, bus2: 2 } },
          { class: 'BusFault', id: 'fault', ports: { bus: 2, control_signal: 1 } },
          { class: 'ConstantSignalSource', id: 'source', ports: { sr: 1 } },
        ],
      }),
      catalog,
    )
    const drawn = ['Bus', 'Branch']
    // A drawn element stands for itself.
    expect(await anchors(kase, { id: 'Bus/1', drawn }, signal)).toEqual([])
    expect(await anchors(kase, { id: 'BusFault/fault', drawn }, signal)).toEqual(['Bus/2'])
    // A source reaches its bus through the fault its signal drives.
    expect(await anchors(kase, { id: 'ConstantSignalSource/source', drawn }, signal)).toEqual([
      'Bus/2',
    ])
  })
})
