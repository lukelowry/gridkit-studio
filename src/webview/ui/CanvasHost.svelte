<!-- @component
  Runs a renderer on its canvas and disposes it, even when the mount resolves after teardown. A
  failed start is reported, and the canvas stays empty.
-->
<script lang="ts">
  import { untrack } from 'svelte'

  import { bridge } from '../bridge.js'

  let {
    mount,
    label,
  }: {
    /** Starts the renderer on the canvas; resolves to its disposer. */
    readonly mount: (canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<() => void>
    /** The canvas's accessible name. */
    readonly label: string
  } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let starting = $state(true)

  // One renderer per canvas: `mount` runs untracked, so only a new canvas restarts it.
  $effect(() => {
    const target = canvas
    if (!target) return
    let live = true
    const control = new AbortController()
    let dispose: (() => void) | undefined
    starting = true
    untrack(() => mount(target, control.signal)).then(
      (disposer) => {
        if (!live) return disposer()
        dispose = disposer
        starting = false
      },
      (error: unknown) => {
        if (!live) return
        starting = false
        bridge.report(error)
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
  <canvas class="canvas-host__canvas" tabindex="0" aria-label={label} bind:this={canvas}></canvas>
</div>
