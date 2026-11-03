import type { Gpu, View } from 'latkit'

export function followPlayback(
  gpu: Gpu,
  views: () => Iterable<View>,
  now: () => number,
): () => void {
  return gpu.on('frame', () => {
    const at = now()
    for (const view of views()) view.at = at
  })
}
