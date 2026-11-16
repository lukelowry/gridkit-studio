<!-- @component A latkit view on its own canvas. `onready` may return a cleanup. -->
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
    /** The time to show, unless the owner sets it on the view itself. */
    at?: number
    active?: boolean
    /** The initial camera; without one, the view fits everything. */
    camera?: Partial<Camera>
    onready: (view: CanvasView) => (() => void) | void
    /** Called once a frame first draws the view completely. */
    ondrawn?: () => void
    onerror: (error: unknown) => void
    label: string
  } = $props()

  let canvasView = $state.raw<CanvasView>()

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
          canvasView = opened
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
        if (canvasView === owned) canvasView = undefined
      }
    }
  }

  $effect(() => {
    if (canvasView) canvasView.view.sources = sources
  })
  $effect(() => {
    if (canvasView) canvasView.scene = scene
  })
  $effect(() => {
    if (canvasView && at !== undefined) canvasView.view.at = at
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
