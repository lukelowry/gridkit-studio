<!-- One lane per plotted signal of the results on show, stacked over one time axis that the last
  labels. Plots are added from the view's title bar, which also names the results, and played from
  the status bar. Without results or plots, it says how to get them. -->
<script lang="ts">
  import type { Data, Domain, Query } from '@latkit/model'
  import { onMount } from 'svelte'

  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { type ClockState, IDLE } from '../../shared/transport.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { CanvasGpu } from '../gpu.js'
  import { Recovery } from '../recovery.js'
  import { ofShown, plotStatics, Rows, type Snapshot } from '../rows.js'
  import { leastWants, plotBudget, plotNeeds, Samples, type Wants } from '../samples.js'
  import { theme, watchTheme } from '../theme.js'
  import { monitorWindow, sameWindow } from './plot.js'
  import Plot from './Plot.svelte'

  /** How long a window the user chose must rest before the extension hears of it. */
  const WINDOW_MS = 120

  let view = $state.raw<ViewState>({})
  /** The case the results were read against, and the samples of them the plots draw. */
  let rows = $state.raw<Snapshot | undefined>()
  const cases = new Rows(bridge, () => (rows = cases.snapshot))
  /** Bumped as samples arrive. */
  let held = $state(0)
  const samples = new Samples(bridge, () => held++, plotBudget)
  /** The case's rows with the samples of them, and the content they are of. */
  let made = $state.raw<{ data: Data; fingerprint: string } | undefined>()
  /** What the plots draw: only what was made of the content of the results on show, so a state that
   *  names other results waits for rows of their own. */
  const source = $derived(
    made && made.fingerprint === (view.results?.fingerprint ?? view.summary?.fingerprint)
      ? made.data
      : undefined,
  )
  let sampled = $state.raw<readonly Query.Selection[]>([])
  /** Whether the plots read their window a slice at a time, as it holds more than the budget, and
   *  the slice they read now: null once they have drawn the window. */
  let streaming = $state(false)
  let slicing: Domain | null | undefined
  /** Whether what the plots lack could not be read, which a notification said. */
  let stuck = $state(false)
  /** Where each plot's drawing stands, by plot. */
  let wants = $state.raw<ReadonlyMap<string, Wants>>(new Map())
  /** The clock as of its last change. */
  let tick = $state.raw<ClockState>(IDLE)
  /** The playhead, updated every frame while playing. */
  let t = $state(0)
  let colors = $state.raw(theme())
  /** Bumped on GPU loss or retry; canvases remount while lane state survives. */
  let epoch = $state(0)
  /** How many times the user asked the Monitor to try again. */
  let retries = $state(0)
  /** Whether VS Code shows the view; a hidden view keeps its webview but stops drawing. */
  let visible = $state(true)
  let hidden = $state(document.hidden)
  const paused = $derived(!visible || hidden)
  /** The window the user chose, and the last one sent to the extension. */
  let chosen = $state.raw<Domain | undefined>()
  let told: Domain | undefined
  let telling: ReturnType<typeof setTimeout> | undefined

  const owner = new CanvasGpu()
  const recovery = new Recovery(() => epoch++, bridge.report)
  const gpu = () => owner.get((reason) => recovery.fail(reason))
  const clock = createClock(
    (now) => {
      if (!paused) t = now
    },
    () => (tick = clock.state),
  )
  $effect(() => {
    if (!paused) t = clock.now()
  })

  const results = $derived(view.results)
  const plots = $derived(view.plots ?? [])
  const shown = $derived(monitorWindow(results, chosen ?? view.window))
  const keyOf = (plot: Plotted) => `${plot.from}\n${plot.field}\n${plot.id ?? ''}`

  // The rows the plots draw of the case the results were read against, which the summary then
  // describes, or of the case on show while there are none.
  $effect(() => {
    const { summary, results } = view
    if (!summary || (view.stale && !results?.frames)) return
    cases.want(
      { summary, ...(results?.frames && { results: results.id }) },
      plotStatics(summary, plots),
    )
  })
  // The plots draw the samples over the times shown; those around them load after, so a pan
  // finds them held. A window holding more than the budget streams instead: a slice at a time from
  // where the plots' drawing stands, the slices drawn letting go as later ones come.
  $effect(() => {
    void held
    const span = shown
    const slice = samples.plot(
      view.results,
      plotNeeds(view),
      span,
      leastWants(plots.map((plot) => wants.get(keyOf(plot)))),
      { at: (span[0] + span[1]) / 2, travel: 0 },
    )
    streaming = slice !== undefined
    slicing = slice
    made =
      rows && ofShown(rows, view)
        ? { data: samples.data(rows.data), fingerprint: rows.fingerprint }
        : undefined
    sampled = samples.sampled()
    stuck = samples.stuck
  })
  /** Hears where `plot`'s drawing stands after each frame, and that it draws no more. */
  function drew(plot: Plotted, stands: Wants | undefined) {
    const key = keyOf(plot)
    if (wants.get(key) === stands) return
    const next = new Map(wants)
    if (stands === undefined) next.delete(key)
    else next.set(key, stands)
    wants = next
  }
  /** Whether the samples held cover `window` of `from`'s `field`. */
  const covers = (from: string, field: string, window: Domain) =>
    samples.covers(from, field, window)

  /** Every plot follows `bounds` at once; the extension hears once they rest. */
  function turn(bounds: Domain) {
    chosen = bounds
    clearTimeout(telling)
    telling = setTimeout(() => {
      told = bounds
      bridge.send({ kind: 'window', bounds })
    }, WINDOW_MS)
  }

  onMount(() => {
    const stops = [
      bridge.on((incoming) => {
        if (incoming.kind === 'state') {
          const before = view
          view = merged(view, incoming.state)
          // Other results reset the window, and the plots draw them from the start; a window the
          // extension set replaces the user's.
          if (view.results?.id !== before.results?.id) {
            clearTimeout(telling)
            chosen = told = undefined
            wants = new Map()
          } else if (!sameWindow(view.window, before.window) && !sameWindow(view.window, told)) {
            clearTimeout(telling)
            chosen = told = undefined
          }
        } else if (incoming.kind === 'shown') visible = incoming.shown
        else if (incoming.kind === 'action' && incoming.command === 'reloadView') {
          recovery.reset()
          retries++
          epoch++
          cases.retry()
          samples.retry()
        }
      }),
      watchTheme(() => (colors = theme())),
    ]
    const visibility = () => (hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    // What the plots hold, for the tests.
    ;(window as { gridkitMonitor?: () => unknown }).gridkitMonitor = () => ({
      streaming,
      slice: slicing,
      wants: Object.fromEntries(wants),
      budget: samples.budget,
      ...samples.stats(),
    })
    bridge.ready()
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      clearTimeout(telling)
      for (const stop of stops) stop()
      clock.stop()
      samples.clear()
      recovery.dispose()
      owner.dispose()
    }
  })
</script>

<div class="monitor">
  {#if plots.length === 0 || !results}
    <div class="c-empty monitor__empty">
      {#if !view.uri}
        <!-- No case is open: nothing to show. -->
      {:else if !view.summary}
        <p class="c-empty__text">Loading case…</p>
      {:else if !results}
        <p class="c-empty__text">
          Right-click a .solver.json and choose Run Dynamic Simulation to see its results here.
        </p>
      {:else if results.outputs.length}
        <!-- Until GridKit writes the header, the results hold nothing to plot yet. -->
        <p class="c-empty__text">Add a plot from the title bar.</p>
      {/if}
    </div>
  {:else}
    <div class="monitor__lanes" data-testid="monitor-lanes">
      {#each plots as plot, i (keyOf(plot))}
        <Plot
          {plot}
          {view}
          {source}
          {sampled}
          {covers}
          {t}
          {shown}
          theme={colors}
          {clock}
          {tick}
          {gpu}
          {paused}
          generation={epoch}
          {retries}
          ticks={i === plots.length - 1}
          {streaming}
          {stuck}
          onframe={() => recovery.presented()}
          onwants={(stands) => drew(plot, stands)}
          onwindow={turn}
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
    container: monitor / inline-size;
  }

  .monitor__empty {
    flex: 1;
  }

  /* One above another, sharing the time axis; the 1px gap shows the border color as hairlines. */
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
