import { expect, it } from 'vitest'

import type { Results, Summary, ViewState } from './messages.js'
import { applied, changes } from './state.js'

const summary = { uri: 'file:///a.case.json', version: 1, name: 'a' } as Summary
const results = (frames: number, outputs: Results['outputs']) =>
  ({ id: 'run', frames, growing: true, domain: [0, frames], outputs }) as unknown as Results

it('sends a view each part it reads as that part changes, and the page ends up holding the same', () => {
  const outputs = [{ table: 'Bus', field: 'Vm', ids: [1, 2] }]
  const selection = { table: 'Bus', id: 1 }
  const plots = [{ table: 'Bus', field: 'Vm' }]
  const states: ViewState[] = [
    { uri: summary.uri, summary, plots, selection },
    { uri: summary.uri, summary, plots, selection, results: results(1, outputs) },
    { uri: summary.uri, summary, plots, selection, results: results(2, outputs) },
    { uri: summary.uri, summary, plots, window: [0, 1] },
  ]
  let sent: ViewState = {}
  let page: ViewState = {}
  const sizes: number[] = []
  for (const state of states) {
    const changed = changes('monitor', state, sent)!
    sizes.push(Object.keys(changed).length)
    // As a message carries it: a part that is gone crosses as null.
    const held = page
    page = applied(page, JSON.parse(JSON.stringify(changed)))
    sent = state
    expect(page).toEqual(JSON.parse(JSON.stringify(state)))
    // A part that did not change is the object the page held, not one like it.
    if (!('summary' in changed)) expect(page.summary).toBe(held.summary)
  }
  // The whole state first, then only what changed: the results as they grow, without the outputs
  // the page holds, then the selection and results that went and the window that came.
  expect(sizes).toEqual([4, 1, 1, 3])
  expect(changes('monitor', states[2]!, states[1]!)!.results).not.toHaveProperty('outputs')
  expect(changes('monitor', states[3]!, states[2]!)).toMatchObject({
    results: null,
    selection: null,
  })
  expect(changes('monitor', states[3]!, states[3]!)).toBeUndefined()
})

it('sends a view nothing of a part it does not read', () => {
  const table = { type: 'Bus' }
  expect(changes('network', { uri: summary.uri, table }, {})).toEqual({ uri: summary.uri })
  expect(changes('case', { uri: summary.uri, table }, {})).toEqual({ uri: summary.uri, table })
})
