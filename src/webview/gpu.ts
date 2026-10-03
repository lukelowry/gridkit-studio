import { createGpu, type Gpu, parseColor } from '@latkit/gpu'
export function theme(kind: 'network' | 'diagram' | 'monitor' = 'monitor') {
  const css = getComputedStyle(document.body)
  const color = (name: string, fallback: string) =>
    parseColor(css.getPropertyValue(name).trim() || fallback)!
  const foreground = color('--vscode-foreground', '#cccccc')
  return {
    background: color('--vscode-editor-background', '#1e1e1e'),
    textColor: foreground,
    ...(kind === 'network' ? { surfaceColor: color('--vscode-editor-background', '#1e1e1e') } : {}),
    gridColor: color('--vscode-editorIndentGuide-background1', '#404040'),
    ...(kind !== 'monitor'
      ? {
          vertexBaseColor:
            kind === 'network' ? foreground : color('--vscode-editorWidget-background', '#252526'),
          edgeBaseColor: foreground,
        }
      : {}),
    ...(kind === 'diagram' ? { outlineColor: color('--vscode-contrastBorder', '#808080') } : {}),
    selectedColor: color('--vscode-focusBorder', '#007fd4'),
    hoverColor: color('--vscode-editorHoverWidget-border', '#454545'),
    motion: 'auto' as const,
  }
}
export class CanvasGpu {
  gpu?: Gpu
  #pending?: Promise<Gpu>
  #closed = false
  async get(lost: () => void): Promise<Gpu> {
    if (this.gpu) return this.gpu
    return (this.#pending ??= createGpu({
      budget: { cpuBytes: 64 << 20, gpuBytes: 128 << 20, stagingBytes: 16 << 20 },
      maxFramesInFlight: 2,
    })
      .then((gpu) => {
        if (this.#closed) {
          gpu.destroy()
          throw new Error('View closed')
        }
        this.gpu = gpu
        gpu.signal.addEventListener(
          'abort',
          () => {
            this.gpu = undefined
            this.#pending = undefined
            if (!this.#closed) lost()
          },
          { once: true },
        )
        return gpu
      })
      .catch((error) => {
        this.#pending = undefined
        throw error
      }))
  }
  dispose() {
    this.#closed = true
    this.gpu?.destroy()
    this.gpu = undefined
  }
}
