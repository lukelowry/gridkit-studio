<script lang="ts">
  import { type Camera, type Gpu, type Scene, type Source, View } from 'latkit'
  import { untrack } from 'svelte'

  import { createView } from '../runtime.js'

  let {
    gpu,
    scene,
    sources,
    at = 0,
    active = true,
    camera,
    onready,
    onerror,
    label,
  }: {
    gpu: Gpu
    scene: Scene
    sources: readonly Source[]
    at?: number
    active?: boolean
    camera?: Camera
    onready: (view: View, canvas: HTMLCanvasElement) => (() => void) | void
    onerror: (error: unknown) => void
    label: string
  } = $props()

  let view = $state.raw<View>()

  function attach(canvas: HTMLCanvasElement) {
    const device = gpu
    if (!active) return
    let ended = false
    let owned: View | undefined
    let disconnect: (() => void) | void
    let rendered: (() => void) | undefined
    const options = untrack(() => ({ gpu: device, sources, ...(camera ? { camera } : {}) }))
    void createView(
      canvas,
      untrack(() => scene),
      options,
    ).then(
      (created) => {
        if (ended) {
          created.destroy()
          return
        }
        owned = created
        try {
          disconnect = untrack(() => onready(created, canvas))
          view = created
          rendered = device.on('frame', () => {
            if (created.stats.frames > 0 && created.complete) {
              canvas.dataset.rendered = 'true'
              rendered?.()
              rendered = undefined
            }
          })
        } catch (error) {
          created.destroy()
          owned = undefined
          onerror(error)
        }
      },
      (error: unknown) => {
        if (!ended) onerror(error)
      },
    )
    return () => {
      ended = true
      rendered?.()
      delete canvas.dataset.rendered
      try {
        disconnect?.()
      } finally {
        owned?.destroy()
        if (view === owned) view = undefined
      }
    }
  }

  $effect(() => {
    if (view) view.sources = sources
  })
  $effect(() => {
    if (view) view.scene = scene
  })
  $effect(() => {
    if (view) view.at = at
  })
</script>

<canvas {@attach attach} aria-label={label} tabindex="0"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
</style>
