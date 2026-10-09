import { describe, expect, it } from 'vitest'

import { catalog } from '../gridkit/definition.js'
import type { Begin, Summary, ViewState } from './messages.js'
import { currentStream, drawable } from './streams.js'

describe('mapping readiness', () => {
  const revision = { uri: 'file:///case', version: 1, attachmentId: 'first' }
  const summary: Summary = {
    ...revision,
    name: 'Case',
    fingerprint: 'one',
    schema: catalog.schema,
    editable: {},
    identities: {},
    counts: { Bus: 2 },
    recording: { listed: {} },
    issues: [],
    validation: 'pending',
    parseMs: 0,
  }
  const begin: Begin = {
    kind: 'begin',
    stream: 1,
    revision,
    schema: catalog.schema,
    counts: summary.counts,
    fields: [{ from: 'Bus', select: ['name', 'params.kv'] }],
    base: true,
  }
  const state: ViewState = {
    summary,
    bindings: { vertexColor: { type: 'Bus', field: 'params.kv' } },
  }

  it('keeps the old frame until the current attachment and mapping fields are ready', () => {
    expect(drawable(begin, state)).toBe(true)
    expect(drawable(begin, { ...state, stale: true })).toBe(false)
    expect(drawable(begin, { ...state, summary: { ...summary, attachmentId: 'reopened' } })).toBe(
      false,
    )
    expect(drawable(begin, { ...state, summary: { ...summary, uri: 'file:///other' } })).toBe(false)
    expect(drawable(begin, { ...state, summary: { ...summary, version: 2 } })).toBe(false)
    expect(drawable({ ...begin, fields: [{ from: 'Bus', select: ['name'] }] }, state)).toBe(false)
  })

  it('restyles an already held field without a data reload when its normalization changes', () => {
    expect(
      drawable(begin, {
        ...state,
        bindings: {
          vertexColor: { type: 'Bus', field: 'params.kv', domain: [100, 500] },
        },
      }),
    ).toBe(true)
    expect(drawable(begin, { ...state, bindings: {} })).toBe(true)
  })

  it('draws rows whose mapping reads a sampled field, which comes in pages of the run', () => {
    expect(
      drawable(
        { ...begin, fields: [{ from: 'Bus', select: ['name'] }] },
        { ...state, bindings: { vertexColor: { type: 'Bus', field: 'Vm' } } },
      ),
    ).toBe(true)
  })

  it('accepts a rows-only snapshot before samples, and rejects samples from a replaced run', () => {
    const showing = { ...state, run: { id: 'new', frames: 0 } } as ViewState
    expect(currentStream(begin, showing)).toBe(true)
    expect(currentStream({ ...begin, simulationId: 'old' }, showing)).toBe(false)
    expect(currentStream({ ...begin, simulationId: 'new' }, showing)).toBe(true)
  })
})
