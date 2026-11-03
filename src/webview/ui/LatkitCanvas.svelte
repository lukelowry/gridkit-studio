<script lang="ts">
  import type { Camera, Gpu, Scene, Source, View } from 'latkit'
  import { untrack } from 'svelte'

  import { ViewHost } from '../host.js'

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

  let host = $state.raw<ViewHost>()

  function attach(canvas: HTMLCanvasElement) {
    const device = gpu
    if (!active) return
    let ended = false
    let owned: ViewHost | undefined
    let disconnect: (() => void) | void
    const options = untrack(() => ({ gpu: device, sources, ...(camera ? { camera } : {}) }))
    void ViewHost.open(
      canvas,
      untrack(() => scene),
      options,
      onerror,
    ).then(
      (opened) => {
        if (ended) {
          opened.destroy()
          return
        }
        owned = opened
        try {
          disconnect = untrack(() => onready(opened.view, canvas))
          host = opened
        } catch (error) {
          opened.destroy()
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
      try {
        disconnect?.()
      } finally {
        owned?.destroy()
        if (host === owned) host = undefined
      }
    }
  }

  $effect(() => {
    if (host) host.view.sources = sources
  })
  $effect(() => {
    if (host) host.scene = scene
  })
  $effect(() => {
    if (host) host.view.at = at
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
