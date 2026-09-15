import { colormap, type ColormapName, COLORMAPS } from '@latkit/colormaps'
import { OPTIONS, type Options, validateOptions } from '@latkit/network'
export type DisplayOptions = Omit<Options, 'devices' | 'colormap' | 'msaa'> & {
  colormap?: ColormapName
  shade?: 'none' | 'spotlight'
}
export const optionLabel = (key: string): string =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
export function rendererOptions(options: DisplayOptions): Options {
  const { colormap: name, shade: _shade, ...rest } = options
  return { ...rest, ...(name && { colormap: colormap(name) }) }
}
export function validOptions(value: unknown): value is DisplayOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (key === 'shade') {
      if (item !== 'none' && item !== 'spotlight') return false
    } else if (key === 'colormap') {
      if (typeof item !== 'string' || !Object.hasOwn(COLORMAPS, item)) return false
    } else if (!Object.hasOwn(OPTIONS, key) || !OPTIONS[key as keyof typeof OPTIONS].live)
      return false
  }
  try {
    validateOptions(rendererOptions(value as DisplayOptions))
    return true
  } catch {
    return false
  }
}
