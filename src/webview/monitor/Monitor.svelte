<script lang="ts">
  import type { View } from 'latkit'
  import { onMount } from 'svelte'

  import type { TimeRange } from '../../shared/data.js'
  import type { ViewState } from '../../shared/messages.js'
  import { bridge } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { picture, saveImage } from '../export/image.js'
  import { plotViews } from '../export/plots.js'
  import { followPlayback } from '../latkit/canvas.js'
  import { LatkitPage } from '../latkit/page.svelte.js'
  import { monitorWindow, sameWindow, SETTLE_MS } from './plot.js'
  import Plot from './Plot.svelte'

  const page = new LatkitPage((error) => bridge.report(error))
  const fail = page.fail
  let app = $state.raw<ViewState>({})
  let t = $state(0)
  let chosen = $state.raw<TimeRange>()
  const views = new Set<View>()
  /** Lets go of an image being drawn once the page goes. */
  const lifetime = new AbortController()
  let following: (() => void) | undefined
  let telling: ReturnType<typeof setTimeout> | undefined
  const active = $derived(page.active)
  const results = $derived(app.results)
  const plots = $derived(app.plots ?? [])
  /** The window every plot shows, the same one while results arrive that leave it where it was: a
   *  plot handed a window anew moves its camera, which starts latkit fitting its values again. */
  let steady: TimeRange | undefined
  const shown = $derived.by(() => {
    const next = monitorWindow(results, chosen ?? app.window)
    return (steady = sameWindow(steady, next) ? steady! : next)
  })
  const clock = createClock((at) => {
    t = at
    if (active) for (const view of views) view.at = at
  }, follow)

  function follow() {
    following?.()
    following = undefined
    const gpu = page.gpu
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
    const gpu = page.gpu
    if (!gpu || !results || !app.uri || !app.summary || !lanes) return
    const size = [lanes.clientWidth, lanes.scrollHeight] as const
    const plots = await plotViews(app, results, gpu, shown, [0, 0, 1, 1], lifetime.signal)
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
  /** A zoom or pan: the plots show it at once, and the extension hears of it once it rests. */
  function turn(range: TimeRange) {
    chosen = range
    clearTimeout(telling)
    telling = setTimeout(() => bridge.send({ kind: 'window', bounds: range }), SETTLE_MS)
  }
  $effect(() => {
    void active
    void page.gpu
    follow()
  })
  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'state') {
        const old = app
        app = message.state
        if (old.results?.id !== app.results?.id || old.window !== app.window) chosen = undefined
      } else if (message.kind === 'action') {
        if (message.command === 'reloadView') void page.open()
        else if (message.command === 'fit') {
          // A zoom or pan not yet said would take Fit's place once it was.
          clearTimeout(telling)
          chosen = undefined
          bridge.send({ kind: 'window', bounds: monitorWindow(results) })
        } else if (message.command === 'exportImage') void exportImage().catch(fail)
      }
    })
    const hooks = window as Window & { gridkitMonitor?: () => unknown }
    hooks.gridkitMonitor = () => ({
      views: views.size,
      work: page.gpu?.work,
      resident: page.gpu?.resident,
      uploading: page.gpu?.uploading,
      plots: [...views].map((view) => ({
        ...view.stats,
        at: view.at,
        camera: view.camera,
      })),
    })
    bridge.ready()
    return () => {
      lifetime.abort()
      following?.()
      clock.stop()
      off()
      clearTimeout(telling)
      page.destroy()
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
  {:else if page.gpu}
    <div class="monitor__lanes" data-testid="monitor-lanes">
      {#each plots as plot (JSON.stringify([results.id, plot.table, plot.field, plot.id]))}
        <Plot
          {plot}
          {app}
          gpu={page.gpu}
          {active}
          {shown}
          {t}
          {clock}
          themeVersion={page.themeVersion}
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
