<!-- @component
  Own a renderer's canvas and cleanup, including late mounts. Children overlay the canvas; failures
  replace it. From Lattice.
-->
<script lang="ts">
  import { type Snippet, untrack } from 'svelte'

  let {
    mount,
    fault = null,
    label,
    children,
  }: {
    /** Starts the renderer on the canvas and resolves to its disposer. */
    readonly mount: (canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<() => void>
    /** A problem the renderer recovered from, as text for an alert over the live canvas. */
    readonly fault?: string | null
    /** The canvas's accessible name. */
    readonly label: string
    readonly children?: Snippet
  } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let starting = $state(true)
  let failure = $state<string | null>(null)

  // One renderer per canvas: the mount runs once the canvas exists, whatever `mount` reads.
  $effect(() => {
    const target = canvas
    if (!target) return
    let live = true
    const control = new AbortController()
    let dispose: (() => void) | undefined
    starting = true
    failure = null
    untrack(() => mount(target, control.signal)).then(
      (disposer) => {
        if (!live) return disposer()
        dispose = disposer
        starting = false
      },
      (error: unknown) => {
        if (!live) return
        failure = error instanceof Error ? error.message : String(error)
        starting = false
      },
    )
    return () => {
      live = false
      control.abort()
      dispose?.()
    }
  })
</script>

<div class="canvas-host" aria-busy={starting}>
  {#if fault}
    <div class="canvas-host__fault" role="alert"><p>{fault}</p></div>
  {/if}
  <canvas class="canvas-host__canvas" tabindex="0" aria-label={label} bind:this={canvas}></canvas>
  {#if failure}
    <div class="canvas-host__fallback c-empty" role="alert">
      <p class="c-empty__text">This view could not start its WebGPU renderer. {failure}</p>
    </div>
  {:else}
    {@render children?.()}
  {/if}
</div>
