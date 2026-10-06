import { describe, expect, it } from 'vitest'

import { catalog } from '../gridkit/definition.js'
import type { Begin, Summary, ViewState } from './messages.js'
import { drawable, holdFor } from './streams.js'

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
    parameters: {},
    issues: [],
    validation: 'pending',
    parseMs: 0,
  }
  const begin: Begin = {
    kind: 'begin',
    stream: 1,
    revision,
    schema: catalog.schema,
    fields: [{ from: 'Bus', select: ['name', 'params.kv'] }],
    sampled: [],
    base: true,
    append: false,
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
})

describe('the window of a run a view holds', () => {
  it('holds the times it needs with a margin either side', () => {
    expect(holdFor(undefined, [10, 20], false, 10)).toEqual({ from: 0, to: 30 })
    expect(holdFor(undefined, [4, 9], false, 0)).toEqual({ from: 4, to: 9 })
  })

  it('keeps what it holds while that covers the need, and lets it go once the need leaves', () => {
    const held = { from: 0, to: 30 }
    expect(holdFor(held, [5, 15], false, 10)).toBe(held)
    expect(holdFor(held, [20, 30], false, 10)).toBe(held)
    expect(holdFor(held, [25, 35], false, 10)).toEqual({ from: 15, to: 45 })
    expect(holdFor(held, [-5, 5], false, 10)).toEqual({ from: -15, to: 15 })
  })

  it('holds an open window from its start on, so arriving frames are appended', () => {
    const open = holdFor(undefined, [10, 20], true, 10)
    expect(open).toEqual({ from: 0 })
    // The need follows the head; one window serves until its start trails three spans behind.
    expect(holdFor(open, [25, 35], true, 10)).toBe(open)
    expect(holdFor(open, [30, 40], true, 10)).toBe(open)
    expect(holdFor(open, [31, 41], true, 10)).toEqual({ from: 21 })
  })

  it('starts over when the view turns from following the head to a span, or back', () => {
    expect(holdFor({ from: 0 }, [5, 15], false, 0)).toEqual({ from: 5, to: 15 })
    expect(holdFor({ from: 0, to: 30 }, [5, 15], true, 0)).toEqual({ from: 5 })
  })
})
