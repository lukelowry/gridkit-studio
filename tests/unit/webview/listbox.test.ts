import { describe, expect, it } from 'vitest'

import {
  indexOptions,
  layoutOptions,
  type OptionGroup,
  type OptionRow,
  windowRuns,
} from '../../../src/webview/ui/listbox.js'

/** Whether a slot holds a row rather than a heading. */
const isRow = <T>(slot: OptionGroup | OptionRow<T>): slot is OptionRow<T> => 'nav' in slot

describe('the listbox model', () => {
  it('gives headings and rows one slot each, and skips disabled rows in keyboard order', () => {
    const index = indexOptions([
      { value: 'a', label: 'Alpha', group: 'First' },
      { value: 'b', label: 'Beta', group: 'Second', disabled: true },
      { value: 'c', label: 'Gamma', group: 'First' },
    ])
    const layout = layoutOptions(index, 'None')
    expect(layout.slots.map((slot) => (isRow(slot) ? slot.value : `# ${slot.label}`))).toEqual([
      null,
      '# First',
      'a',
      'c',
      '# Second',
      'b',
    ])
    expect(layout.nav.map((row) => row.value)).toEqual([null, 'a', 'c'])
    expect(layout.navOf.get('c')).toBe(2)
    expect(layout.navOf.has('b')).toBe(false)
    expect(layout.slots.filter(isRow).map((row) => row.nav)).toEqual([0, 1, 2, -1])
    expect(index.byKey.get('b')?.label).toBe('Beta')
  })

  it('numbers each ARIA set: a named group, or every row under no heading together', () => {
    const layout = layoutOptions(
      indexOptions([
        { value: 'a', label: 'Alpha', group: 'Named' },
        { value: 'b', label: 'Beta', group: 'Named' },
        { value: 'c', label: 'Gamma' },
      ]),
      'None',
    )
    expect(
      layout.slots.filter(isRow).map((row) => [row.value, row.posinset, row.group.setsize]),
    ).toEqual([
      [null, 1, 2],
      ['a', 1, 2],
      ['b', 2, 2],
      ['c', 2, 2],
    ])
    const groups = layout.slots.filter(isRow).map((row) => row.group)
    expect(groups.map((group) => [group.label, group.start, group.end])).toEqual([
      ['', 0, 1],
      ['Named', 1, 4],
      ['Named', 1, 4],
      ['', 4, 5],
    ])
  })

  it('searches labels for every word, never values, dropping the clear row and empty groups', () => {
    const index = indexOptions([
      { value: '90210', label: '90210 - North station', group: 'A' },
      { value: '2', label: '2 - South station', group: 'B' },
      { value: '{"classId":"Bus"}', label: 'Bus · Vm' },
    ])
    expect(layoutOptions(index, 'None', ' north 902 ').nav.map((row) => row.value)).toEqual([
      '90210',
    ])
    expect(layoutOptions(index, 'None', 'STATION').nav).toHaveLength(2)
    expect(
      layoutOptions(index, 'None', 'STATION').slots.filter((slot) => !isRow(slot)),
    ).toHaveLength(2)
    expect(layoutOptions(index, 'None', 'classid').slots).toEqual([])
    expect(layoutOptions(index, 'None', ' ').nav[0]?.value).toBeNull()
    expect(layoutOptions(index, null).nav[0]?.value).toBe('90210')
  })

  it('windows a 100k list by slice and keeps the offscreen cursor mounted', () => {
    const index = indexOptions(
      Array.from({ length: 100_000 }, (_, i) => ({ value: String(i), label: `Bus ${i}` })),
    )
    const layout = layoutOptions(index, 'None')
    const runs = windowRuns(layout, 50_000, 16, layout.nav[100_000])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.rows.map((row) => row.slot)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => 50_000 + i),
      100_000,
    ])
    expect(windowRuns(layout, 50_000, 16, layout.nav[3])[0]!.rows[0]!.slot).toBe(3)
    expect(windowRuns(layout, 200_000, 16)).toEqual([])
  })

  it('splits a window into runs by group, the pinned row in its own', () => {
    const layout = layoutOptions(
      indexOptions(
        Array.from({ length: 1000 }, (_, i) => ({
          value: String(i),
          label: String(i),
          group: `Group ${Math.floor(i / 10)}`,
        })),
      ),
      null,
    )
    const runs = windowRuns(layout, 9, 5, layout.nav[500])
    expect(runs.map((run) => [run.group.label, run.rows.map((row) => row.value)])).toEqual([
      ['Group 0', ['8', '9']],
      ['Group 1', ['10', '11']],
      ['Group 50', ['500']],
    ])
    expect(runs[1]!.group.setsize).toBe(10)
  })
})
