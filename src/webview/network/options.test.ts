import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import type { Palette } from '../theme.js'
import { networkOptions } from './options.js'

const palette = new Proxy({}, { get: () => [0.8, 0.8, 0.8, 1] }) as Palette

describe('networkOptions', () => {
  it('colors an unmapped edge with the average of its ends', () => {
    expect(networkOptions(reader(), palette, 'mono', false).edgeBaseColor).toBeNull()
  })
  it('keeps an edge color the reader chose', () => {
    const s = reader({ 'network.edgeBaseColor': '#ff0000' })
    expect(networkOptions(s, palette, 'mono', false).edgeBaseColor).toEqual([1, 0, 0, 1])
  })
})
