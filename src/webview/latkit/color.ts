/** Colors worked out in OKLab, where equal steps look equal in every theme. */

/** sRGB channels from 0 to 1. */
export type Rgb = readonly [red: number, green: number, blue: number]
type Lab = readonly [lightness: number, a: number, b: number]

/** The hue of water, in OKLCH radians: an azure. */
const WATER_HUE = (245 * Math.PI) / 180

/** `color` as sRGB without its alpha: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `rgb()`.
 *  Undefined for anything else. */
export function rgbOf(color: string): Rgb | undefined {
  const text = color.trim()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? hex.replace(/./g, '$&$&') : hex
    const byte = (at: number) => parseInt(full.slice(at, at + 2), 16) / 255
    return [byte(0), byte(2), byte(4)]
  }
  const [r, g, b] = (/^rgba?\(([^)]*)\)$/i.exec(text)?.[1] ?? '')
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return r !== undefined && g !== undefined && b !== undefined && [r, g, b].every(Number.isFinite)
    ? [r / 255, g / 255, b / 255]
    : undefined
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function labOf([red, green, blue]: Rgb): Lab {
  const [r, g, b] = [linear(red), linear(green), linear(blue)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** `lab` as `#rrggbb`, each channel clipped to sRGB. */
function hexOf([lightness, a, b]: Lab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const byte = (c: number) => Math.round(gamma(Math.min(1, Math.max(0, c))) * 255)
  return '#' + channels.map((c) => byte(c).toString(16).padStart(2, '0')).join('')
}

/** `from` moved `share` of the way to `to`. */
export function mix(from: Rgb, to: Rgb, share: number): string {
  const [p, q] = [labOf(from), labOf(to)]
  const at = (i: 0 | 1 | 2) => p[i] + (q[i] - p[i]) * share
  return hexOf([at(0), at(1), at(2)])
}

/** Water on `land`: an azure a step lighter than dark land, light enough to show on black, and a
 *  step darker than light land. */
export function waterOf(land: Rgb): string {
  const [lightness] = labOf(land)
  const [l, chroma] =
    lightness < 0.6 ? [Math.max(lightness + 0.08, 0.3), 0.06] : [lightness - 0.11, 0.065]
  return hexOf([l, chroma * Math.cos(WATER_HUE), chroma * Math.sin(WATER_HUE)])
}
