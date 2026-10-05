import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import type { Palette } from '../theme.js'
import { networkOptions } from './options.js'

const palette = new Proxy({}, { get: () => [0.8, 0.8, 0.8, 1] }) as Palette

describe('networkOptions', () => {
  it('colors an unmapped edge by its ends', () => {
    expect(networkOptions(reader(), palette, 'mono', false).edgeColor).toBe('ends')
  })
  it('keeps an edge color the reader chose', () => {
    const s = reader({ 'network.edgeColor': '#ff0000' })
    expect(networkOptions(s, palette, 'mono', false).edgeColor).toEqual([1, 0, 0, 1])
  })
  it('draws halos in the theme, translucent, unless the reader chose a color with its alpha', () => {
    expect(networkOptions(reader(), palette, 'mono', false).hoverColor).toEqual([
      0.8, 0.8, 0.8, 0.5,
    ])
    const s = reader({ 'network.selectedColor': '#ff000080' })
    expect(networkOptions(s, palette, 'mono', false).selectedColor).toEqual([1, 0, 0, 128 / 255])
  })
})
