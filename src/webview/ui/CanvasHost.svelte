<!-- @component
  Runs a renderer on its canvas and disposes it, even when the mount resolves after teardown. A
  failed start shows a fallback over the canvas.
-->
<script lang="ts">
  import { untrack } from 'svelte'

  import { message } from '../../shared/format.js'

  let {
    mount,
    fault = null,
    label,
  }: {
    /** Starts the renderer on the canvas; resolves to its disposer. */
    readonly mount: (canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<() => void>
    /** A problem the renderer recovered from, shown as an alert over the live canvas. */
    readonly fault?: string | null
    /** The canvas's accessible name. */
    readonly label: string
  } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let starting = $state(true)
  let failure = $state<string | null>(null)

  // One renderer per canvas: `mount` runs untracked, so only a new canvas restarts it.
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
        failure = message(error)
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
  {/if}
</div>
