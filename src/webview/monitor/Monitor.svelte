<script lang="ts">
  import type { Gpu, View } from 'latkit'
  import { onMount, tick } from 'svelte'

  import type { TimeRange } from '../../shared/data.js'
  import type { ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { picture, saveImage, SCALE } from '../export/image.js'
  import { plotViews } from '../export/plots.js'
  import { FrameReads } from '../frames.js'
  import { followPlayback } from '../playback.js'
  import { openGpu, startOver } from '../runtime.js'
  import { watchTheme } from '../theme.js'
  import { monitorWindow, type PlotState, SETTLE_MS } from './plot.js'
  import Plot from './Plot.svelte'

  let app = $state.raw<ViewState>({})
  let gpu = $state.raw<Gpu>()
  let visible = $state(true)
  let hidden = $state(document.hidden)
  let themeVersion = $state(0)
  let t = $state(0)
  let chosen = $state.raw<TimeRange>()
  const reads = new FrameReads()
  const views = new Set<View>()
  /** Lets go of an image being drawn once the page goes. */
  const lifetime = new AbortController()
  const retained = new Map<string, PlotState>()
  function plotState(key: string): PlotState {
    const state = retained.get(key) ?? {}
    retained.set(key, state)
    return state
  }
  $effect(() => {
    const keys = new Set(
      plots.map((plot) => JSON.stringify([results?.id, plot.from, plot.field, plot.id])),
    )
    for (const key of retained.keys()) if (!keys.has(key)) retained.delete(key)
  })
  let closed = false
  let generation = 0
  let following: (() => void) | undefined
  let telling: ReturnType<typeof setTimeout> | undefined
  const active = $derived(visible && !hidden)
  const results = $derived(app.results)
  const plots = $derived(app.plots ?? [])
  const shown = $derived(monitorWindow(results, chosen ?? app.window))
  const clock = createClock((at) => {
    t = at
    if (active) for (const view of views) view.at = at
  }, follow)

  async function device() {
    const current = ++generation
    following?.()
    following = undefined
    const previous = gpu
    gpu = undefined
    await tick()
    views.clear()
    previous?.destroy()
    const created = await openGpu()
    if (closed || current !== generation) {
      created.destroy()
      return
    }
    gpu = created
    follow()
  }
  /** latkit replaces a lost device itself; only once it stops does the page start over. */
  function fail(error: unknown) {
    if (!startOver(error)) bridge.report(error)
  }
  function follow() {
    following?.()
    following = undefined
    if (!gpu || !active || !views.size || clock.state.status !== 'playing') return
    let reported = 0
    following = followPlayback(
      gpu,
      () => views,
      () => {
        const at = clock.now()
        const now = performance.now()
        if (now - reported >= 250) {
          t = at
          reported = now
        }
        return at
      },
    )
  }
  function register(view: View): () => void {
    views.add(view)
    view.at = clock.now()
    follow()
    return () => {
      views.delete(view)
      follow()
    }
  }
  /** An image of every plot, those scrolled out of sight too, as the Monitor stacks them. */
  async function exportImage() {
    const lanes = document.querySelector('[data-testid="monitor-lanes"]')
    if (!gpu || !results || !app.uri || !app.summary || !lanes) return
    const size = [lanes.clientWidth, lanes.scrollHeight] as const
    const plots = await plotViews(
      app,
      results,
      gpu,
      reads,
      shown,
      [0, 0, 1, 1],
      size[0] * SCALE,
      lifetime.signal,
    )
    try {
      for (const { view } of plots.placed) view.at = t
      await saveImage(
        picture(size, plots.placed),
        app.uri,
        app.summary.name,
        'monitor',
        lifetime.signal,
      )
    } finally {
      plots.release()
    }
  }
  /** Whether a zoom or pan is under way: the plots show it at once, and read its samples once it
   *  settles. */
  let settling = $state(false)
  function turn(range: TimeRange) {
    chosen = range
    settling = true
    clearTimeout(telling)
    telling = setTimeout(() => {
      settling = false
      bridge.send({ kind: 'window', bounds: range })
    }, SETTLE_MS)
  }
  $effect(() => {
    void active
    follow()
  })
  onMount(() => {
    void device().catch(fail)
    const off = bridge.on((message) => {
      if (message.kind === 'state') {
        const old = app
        app = merged(app, message.state)
        if (old.results?.id !== app.results?.id) reads.clear()
        if (old.results?.id !== app.results?.id || old.window !== app.window) chosen = undefined
      } else if (message.kind === 'shown') visible = message.shown
      else if (message.kind === 'action') {
        if (message.command === 'reloadView') {
          reads.clear()
          void device().catch(fail)
        } else if (message.command === 'fit') {
          chosen = undefined
          bridge.send({ kind: 'window', bounds: monitorWindow(results) })
        } else if (message.command === 'exportImage') void exportImage().catch(fail)
      }
    })
    const unwatch = watchTheme(() => themeVersion++)
    const visibility = () => (hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    const hooks = window as Window & { gridkitMonitor?: () => unknown }
    hooks.gridkitMonitor = () => ({
      views: views.size,
      cacheBytes: reads.bytes,
      reads: reads.active,
      work: gpu?.work,
      resident: gpu?.resident,
      uploading: gpu?.uploading,
      plots: [...views].map((view) => ({
        ...view.stats,
        at: view.at,
        camera: view.camera,
      })),
    })
    bridge.ready()
    return () => {
      closed = true
      generation++
      lifetime.abort()
      following?.()
      clock.stop()
      off()
      unwatch()
      clearTimeout(telling)
      document.removeEventListener('visibilitychange', visibility)
      reads.clear()
      gpu?.destroy()
      delete hooks.gridkitMonitor
    }
  })
</script>

<div class="monitor">
  {#if !plots.length || !results}
    <div class="c-empty monitor__empty">
      {#if app.uri && !app.summary}<p class="c-empty__text">Loading case…</p>
      {:else if app.uri && !results}<p class="c-empty__text">
          Right-click a .solver.json and choose Run Dynamic Simulation to see its results here.
        </p>
      {:else if results?.outputs.length}<p class="c-empty__text">
          Add a plot from the title bar.
        </p>{/if}
    </div>
  {:else if gpu}
    <div class="monitor__lanes" data-testid="monitor-lanes">
      {#each plots as plot (JSON.stringify([results.id, plot.from, plot.field, plot.id]))}
        <Plot
          {plot}
          kept={plotState(JSON.stringify([results.id, plot.from, plot.field, plot.id]))}
          {app}
          {gpu}
          {reads}
          {active}
          {shown}
          {settling}
          {t}
          {clock}
          {themeVersion}
          {register}
          onwindow={turn}
          onerror={fail}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .monitor {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    overflow: hidden;
  }
  .monitor__empty {
    flex: 1;
  }
  .monitor__lanes {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-block-size: 0;
    overflow-y: auto;
    background: var(--color-border);
  }
</style>
