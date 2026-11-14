<!-- @component
  A latkit view on a canvas of its own: made while `active`, on `gpu`, and kept to what its props
  say. `onready` hears the view once it is made, and may return what to undo as it ends.
-->
<script lang="ts">
  import type { Camera, Gpu, Scene, Source } from 'latkit'
  import { untrack } from 'svelte'

  import { CanvasView } from './canvas.js'

  let {
    gpu,
    scene,
    sources,
    at,
    active = true,
    camera,
    onready,
    ondrawn,
    onerror,
    label,
  }: {
    gpu: Gpu
    scene: Scene
    sources: readonly Source[]
    /** The time the view shows, where its owner does not set it itself. */
    at?: number
    active?: boolean
    /** Where the view looks first; without one, it frames everything. */
    camera?: Partial<Camera>
    onready: (view: CanvasView) => (() => void) | void
    /** Hears once a frame first draws the view whole. */
    ondrawn?: () => void
    onerror: (error: unknown) => void
    label: string
  } = $props()

  let shown = $state.raw<CanvasView>()

  function attach(canvas: HTMLCanvasElement) {
    const device = gpu
    if (!active) return
    let ended = false
    let owned: CanvasView | undefined
    let disconnect: (() => void) | void
    const options = untrack(() => ({ gpu: device, sources, ...(camera ? { camera } : {}) }))
    void CanvasView.open(
      canvas,
      untrack(() => scene),
      options,
      onerror,
      () => untrack(() => ondrawn)?.(),
    ).then(
      (opened) => {
        if (ended) {
          opened.destroy()
          return
        }
        owned = opened
        try {
          disconnect = untrack(() => onready(opened))
          shown = opened
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
        if (shown === owned) shown = undefined
      }
    }
  }

  $effect(() => {
    if (shown) shown.view.sources = sources
  })
  $effect(() => {
    if (shown) shown.scene = scene
  })
  $effect(() => {
    if (shown && at !== undefined) shown.view.at = at
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
