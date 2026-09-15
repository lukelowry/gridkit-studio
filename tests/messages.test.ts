import { expect, it } from 'vitest'

import { isRequest } from '../src/network/messages.js'

it('accepts bounded picks and view capabilities', () => {
  expect(isRequest({ type: 'ready' })).toBe(true)
  expect(
    isRequest({
      type: 'select',
      uri: 'file:///case',
      revision: 'a:2',
      version: 2,
      item: { kind: 'vertex', index: 0 },
    }),
  ).toBe(true)
  expect(
    isRequest({
      type: 'view',
      uri: 'file:///case',
      revision: 'a:2',
      options: {},
      version: 2,
      projection: 'flat',
      projections: ['flat', 'tilt'],
    }),
  ).toBe(true)
})

it.each([
  null,
  {},
  { type: 'execute', command: 'anything' },
  {
    type: 'select',
    uri: 'file:///case',
    revision: 'a:2',
    version: 2,
    item: { kind: 'vertex', index: -1 },
  },
  {
    type: 'select',
    uri: 'file:///case',
    revision: 'a:2',
    version: 2,
    item: { kind: 'vertex', index: 0.5 },
  },
  {
    type: 'select',
    uri: 'file:///case',
    revision: 'a:2',
    version: 2,
    item: { kind: 'unknown', index: 0 },
  },
  { type: 'select', version: -1, item: null },
  {
    type: 'view',
    uri: 'file:///case',
    revision: 'a:2',
    options: {},
    version: 2,
    projection: 'flat',
    projections: ['invalid'],
  },
])('rejects malformed requests: %j', (request) => expect(isRequest(request)).toBe(false))
