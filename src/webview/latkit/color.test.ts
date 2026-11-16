import { expect, it } from 'vitest'

import { mix, type Rgb, rgbOf, waterOf } from './color.js'

/** WCAG's contrast ratio, from 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

it('reads theme colors with or without alpha, and nothing else', () => {
  expect(rgbOf('#ff8000')).toEqual([1, 128 / 255, 0])
  expect(rgbOf('#FF800080')).toEqual(rgbOf('#ff8000'))
  expect(rgbOf('#f80')).toEqual(rgbOf('#ff8800'))
  expect(rgbOf(' rgba(255, 128, 0, 0.5) ')).toEqual(rgbOf('#ff8000'))
  expect(rgbOf('red')).toBeUndefined()
  expect(rgbOf('rgb(1, 2)')).toBeUndefined()
})

it('gives each theme background a blue sea that stands apart from the land', () => {
  // Dark, light, black and white high contrast, and tinted backgrounds of common themes.
  for (const background of [
    '#1f1f1f',
    '#ffffff',
    '#000000',
    '#002b36',
    '#fdf6e3',
    '#000c18',
    '#002451',
    '#390000',
  ]) {
    const land = rgbOf(background)!
    const water = rgbOf(waterOf(land))!
    expect(contrast(water, land), background).toBeGreaterThan(1.2)
    expect(contrast(water, land), background).toBeLessThan(1.7)
    expect(water[2], background).toBeGreaterThan(water[0])
  }
})

it('mixes from one color to the other', () => {
  const [black, white] = [rgbOf('#000000')!, rgbOf('#ffffff')!]
  expect(mix(black, white, 0)).toBe('#000000')
  expect(mix(black, white, 1)).toBe('#ffffff')
  expect(mix(white, white, 0.5)).toBe('#ffffff')
})
