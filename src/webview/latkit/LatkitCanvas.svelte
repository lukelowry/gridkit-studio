<!-- @component A latkit view on its own canvas. `onready` may return a cleanup. -->
<script lang="ts">
  import type { Camera, Gpu, Scene, Source, View } from 'latkit'
  import { untrack } from 'svelte'

  import { CanvasView } from './canvas.js'

  let {
    gpu,
    scene,
    sources,
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
  let failures = $state.raw<View['failures']>([])

  function attach(canvas: HTMLCanvasElement) {
    const device = gpu
    if (!active) return
    const controller = new AbortController()
    let owned: CanvasView | undefined
    let disconnect: (() => void) | void
    let stopFailures: (() => void) | undefined
    const options = untrack(() => ({
      gpu: device,
      sources,
      signal: controller.signal,
      ...(camera ? { camera } : {}),
    }))
    void CanvasView.open(
      canvas,
      untrack(() => scene),
      options,
      onerror,
      () => untrack(() => ondrawn)?.(),
    ).then(
      (opened) => {
        if (controller.signal.aborted) {
          opened.destroy()
          return
        }
        owned = opened
        try {
          disconnect = untrack(() => onready(opened))
          failures = opened.view.failures
          stopFailures = opened.view.on('failures', (current) => (failures = current))
          canvasView = opened
        } catch (error) {
          opened.destroy()
          owned = undefined
          onerror(error)
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) onerror(error)
      },
    )
    return () => {
      controller.abort()
      try {
        stopFailures?.()
        failures = []
        disconnect?.()
      } finally {
        owned?.destroy()
        if (canvasView === owned) canvasView = undefined
      }
    }
  }

  $effect(() => {
    if (!canvasView) return
    const current = canvasView.view.sources
    if (sources.length !== current.length || sources.some((source, i) => source !== current[i]))
      canvasView.view.sources = sources
  })
  $effect(() => {
    if (canvasView && canvasView.view.scene !== scene) canvasView.view.scene = scene
  })
</script>

<canvas {@attach attach} aria-label={label} tabindex="0"></canvas>
{#if failures.length}
  <div class="failures" role="status">
    {#each failures as failure (failure)}
      <div>{failure.message}</div>
    {/each}
  </div>
{/if}

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .failures {
    position: absolute;
    inset-inline-start: var(--spacing-xs);
    inset-block-end: var(--spacing-xs);
    max-inline-size: calc(100% - 2 * var(--spacing-xs));
    padding: var(--spacing-xs);
    background: var(--color-surface-1);
    color: var(--color-text-1);
    overflow-wrap: anywhere;
    pointer-events: none;
  }
</style>
