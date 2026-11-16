<script lang="ts">
  import type { View } from 'latkit'
  import { onMount } from 'svelte'

  import type { TimeRange } from '../../shared/data.js'
  import type { ViewState } from '../../shared/messages.js'
  import { bridge } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { picture, saveImage } from '../export/image.js'
  import { plotViews } from '../export/plots.js'
  import { LatkitPage } from '../latkit/page.svelte.js'
  import { monitorWindow, sameWindow, SETTLE_MS } from './plot.js'
  import Plot from './Plot.svelte'

  const page = new LatkitPage((error) => bridge.report(error))
  const fail = page.fail
  let viewState = $state.raw<ViewState>({})
  let t = $state(0)
  let chosenWindow = $state.raw<TimeRange>()
  const views = new Set<View>()
  const lifetime = new AbortController()
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  let lanes = $state<HTMLElement>()
  const active = $derived(page.active)
  const results = $derived(viewState.results)
  const plots = $derived(viewState.plots ?? [])
  let previousWindow: TimeRange | undefined
  /** The window every plot shows, kept identical while equal: a new window moves each plot's
   *  camera, which restarts latkit's value fit. */
  const timeWindow = $derived.by(() => {
    const next = monitorWindow(results, chosenWindow ?? viewState.window)
    return (previousWindow = sameWindow(previousWindow, next) ? previousWindow! : next)
  })
  const clock = createClock((at) => {
    t = at
    if (active) for (const view of views) view.at = at
  }, follow)

  /** While playing, moves the playhead every frame; the readouts update four times a second. */
  function follow() {
    let reported = 0
    page.follow(
      !!views.size && clock.state.status === 'playing',
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
  /** Exports every plot, including those scrolled out of view, stacked as in the Monitor. */
  async function exportImage() {
    const gpu = page.gpu
    if (!gpu || !results || !viewState.uri || !viewState.summary || !lanes) return
    const size = [lanes.clientWidth, lanes.scrollHeight] as const
    const plots = await plotViews(
      viewState,
      results,
      gpu,
      timeWindow,
      [0, 0, 1, 1],
      lifetime.signal,
    )
    try {
      for (const { view } of plots.placed) view.at = t
      await saveImage(
        picture(size, plots.placed),
        viewState.uri,
        viewState.summary.name,
        'monitor',
        lifetime.signal,
      )
    } finally {
      plots.release()
    }
  }
  /** Shows a zoom or pan at once, and reports it to the extension once it settles. */
  function changeWindow(range: TimeRange) {
    chosenWindow = range
    clearTimeout(windowTimer)
    windowTimer = setTimeout(() => bridge.send({ kind: 'window', bounds: range }), SETTLE_MS)
  }
  $effect(() => {
    void active
    void page.gpu
    follow()
  })
  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'state') {
        const previous = viewState
        viewState = message.state
        if (previous.results?.id !== viewState.results?.id || previous.window !== viewState.window)
          chosenWindow = undefined
      } else if (message.kind === 'action') {
        if (message.command === 'reloadView') void page.open()
        else if (message.command === 'fitAll') {
          // An unreported zoom or pan would otherwise replace the fit once sent.
          clearTimeout(windowTimer)
          chosenWindow = undefined
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
      clock.stop()
      off()
      clearTimeout(windowTimer)
      page.destroy()
      delete hooks.gridkitMonitor
    }
  })
</script>

<div class="monitor">
  {#if !plots.length || !results}
    <div class="c-empty monitor__empty">
      {#if !viewState.uri}<p class="c-empty__text">Open a GridKit case.</p>
      {:else if !viewState.summary}<p class="c-empty__text">Loading case…</p>
      {:else if !results}<p class="c-empty__text">
          Right-click a .solver.json and choose Run Dynamic Simulation to see its results here.
        </p>
      {:else if results.outputs.length}<p class="c-empty__text">Add a plot from the title bar.</p>
      {:else}<p class="c-empty__text">These results hold no signals.</p>{/if}
    </div>
  {:else if page.gpu}
    <div class="monitor__lanes" data-testid="monitor-lanes" bind:this={lanes}>
      {#each plots as plot (JSON.stringify([results.id, plot.table, plot.field, plot.id]))}
        <Plot
          {plot}
          {viewState}
          gpu={page.gpu}
          {active}
          {timeWindow}
          {t}
          {clock}
          themeVersion={page.themeVersion}
          {register}
          onwindow={changeWindow}
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
