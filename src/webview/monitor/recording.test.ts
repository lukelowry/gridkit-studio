import { appendData, createReader } from '@latkit/model'
import { expect, it } from 'vitest'
import { Case, catalog } from '../../gridkit/index.js'

it('reads a recorded subset through the renderer field reader', async () => {
  const kase = await Case.parse('{"buses":[{"class":"Bus","number":1},{"class":"Bus","number":2}]}', catalog)
  const index = kase.table('Bus').index
  const data = appendData(kase.data, [{ kind: 'samples', index, rows: { kind: 'range', offset: 0, count: 1 }, firstFrame: 0, coordinates: Float64Array.of(0, 1, 2), columns: { Vm: { kind: 'numeric', type: 'float64', values: Float64Array.of(1, 0.8, 1), offset: 0, rowStride: 1, frameStride: 1, length: 3 } } }])
  const reader = createReader()
  const scope = reader.open()
  const blocks = []
  try {
    for await (const block of scope.fields({ source: data, from: 'Bus', rows: { kind: 'ids', ids: ['Bus/1'] }, fields: { y: 'Vm' }, window: { kind: 'frames', offset: 0, count: 3 } })) blocks.push(block)
    expect(blocks.length).toBeGreaterThan(0)
  } finally { scope.close(); reader.destroy() }
})
