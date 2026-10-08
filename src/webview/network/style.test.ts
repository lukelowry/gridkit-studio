import { appendData, createData, textColumn } from '@latkit/model'
import { expect, it, vi } from 'vitest'

import type { SimulationInfo, Summary, ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { plotBindings } from '../monitor/plot.js'
import { networkConfig } from './style.js'

vi.mock('./borders.js', () => ({ BORDERS: [] }))
vi.mock('../theme.js', async (original) => ({
  ...(await original<typeof import('../theme.js')>()),
  theme: () => ({ font: 'monospace', palette: new Proxy({}, { get: () => [0.8, 0.8, 0.8, 1] }) }),
}))

it('uses the same global normalization in Network and Monitor whatever pages are held', () => {
  const data = createData(
    {
      types: {
        Bus: {
          fields: {
            longitude: { type: 'float64', geographic: true },
            latitude: { type: 'float64', geographic: true },
            Vm: { type: 'float64', sampled: true },
          },
        },
      },
    },
    [
      {
        kind: 'rows',
        index: { source: 'case', version: 'one', type: 'Bus' },
        rows: { kind: 'range', offset: 0, count: 1 },
        ids: textColumn(['Bus/1']),
        columns: {},
      },
    ],
  )
  const kase = { data, version: 'one' }
  const field = { type: 'Bus', field: 'Vm' }
  for (const state of ['running', 'complete'] as const) {
    const run = {
      state,
      fingerprint: kase.version,
      outputs: [{ from: 'Bus', select: ['Vm'] }],
      domain: [0, 10],
      span: [0, 10],
      domains: { Bus: { Vm: [0.5, 2] } },
    } as unknown as SimulationInfo
    const view: ViewState = {
      run,
      summary: { fingerprint: kase.version, counts: { Bus: 1 } } as unknown as Summary,
      bindings: { vertexColor: field, vertexHeight: field, vertexSize: field },
    }
    for (const at of [0, 4, 10]) {
      const samples = appendData(kase.data, [
        {
          kind: 'samples',
          index: kase.data.tables.Bus!.index,
          rows: { kind: 'range', offset: 0, count: 1 },
          firstFrame: at,
          coordinates: Float64Array.of(at),
          columns: {
            Vm: {
              kind: 'numeric',
              values: Float64Array.of(1.25),
              offset: 0,
              length: 1,
              rowStride: 1,
              frameStride: 1,
            },
          },
        },
      ])
      const config = networkConfig(kase.data, samples, view, false, null)
      for (const channel of ['color', 'z', 'radiusPx'] as const)
        expect(config.vertices.Bus![channel]).toMatchObject({ domain: [0.5, 2] })
      expect(
        plotBindings(reader(), field, view.bindings, undefined, run).traces.plotted!.color,
      ).toMatchObject({ domain: [0.5, 2] })
      const fixed = networkConfig(
        kase.data,
        samples,
        {
          ...view,
          bindings: { vertexColor: { ...field, domain: [0, 3] } },
        },
        false,
        null,
      )
      expect(fixed.vertices.Bus!.color).toMatchObject({ domain: [0, 3] })
    }
  }
})
