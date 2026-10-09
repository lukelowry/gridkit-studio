<!-- One lane per plotted signal of the results on show. Plots are added from the view's title
  bar, which also names the results, and played from the status bar. -->
<script lang="ts">
  import type { Data, Domain, FieldSelection } from '@latkit/model'
  import { onMount } from 'svelte'

  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { type ClockState, IDLE } from '../../shared/transport.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { CanvasGpu } from '../gpu.js'
  import { Recovery } from '../recovery.js'
  import { current, receiveRows, type Snapshot } from '../rows.js'
  import { plotNeeds, Samples } from '../samples.js'
  import { appearance, theme, watchTheme } from '../theme.js'
  import { monitorWindow, sameWindow } from './plot.js'
  import Plot from './Plot.svelte'

  /** How long a window the user chose must rest before the extension hears of it. */
  const WINDOW_MS = 120

  let view = $state.raw<ViewState>({})
  /** The case the results were read against, and the samples of them the plots draw. */
  let rows = $state.raw<Snapshot | undefined>()
  /** Bumped as samples arrive. */
  let held = $state(0)
  const samples = new Samples({
    request: (input, signal) => bridge.request('samples', input, signal),
    changed: () => held++,
    report: (reason) => bridge.report(reason),
  })
  let source = $state.raw<Data | undefined>()
  let sampled = $state.raw<readonly FieldSelection[]>([])
  /** The clock as of its last change. */
  let tick = $state.raw<ClockState>(IDLE)
  /** The playhead, updated every frame while playing. */
  let t = $state(0)
  let colors = $state.raw(theme())
  /** Bumped on GPU loss or retry; canvases remount while lane state survives. */
  let epoch = $state(0)
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

  // The plots draw the samples over the times shown; those around them load after, so a pan
  // finds them held.
  $effect(() => {
    void held
    const span = shown
    samples.want(view.results, plotNeeds(view), span, { at: (span[0] + span[1]) / 2, travel: 0 })
    source = rows && current(rows, view) ? samples.data(rows.data) : undefined
    sampled = samples.sampled()
  })
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
          appearance(view.settings)
          // Other results reset the window; one the extension set replaces the user's.
          if (view.results?.id !== before.results?.id) {
            clearTimeout(telling)
            chosen = told = undefined
          } else if (!sameWindow(view.window, before.window) && !sameWindow(view.window, told))
            chosen = undefined
        } else if (incoming.kind === 'action') {
          if (incoming.command === 'shown') visible = incoming.value === true
          else if (incoming.command === 'resetMonitorWindow') chosen = told = undefined
          else if (incoming.command === 'retryMonitor') {
            epoch++
            samples.retry()
          }
        }
      }),
      receiveRows((next) => (rows = next)),
      watchTheme(() => (colors = theme())),
    ]
    const visibility = () => (hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    bridge.send({ kind: 'ready' })
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
      {#if !view.summary}
        <p class="c-empty__text">Loading case…</p>
      {:else if !results}
        <button class="c-btn" onclick={() => bridge.command('chooseSignals')}>
          Choose monitored signals
        </button>
      {/if}
    </div>
  {:else}
    <div class="monitor__lanes" data-testid="monitor-lanes">
      {#each plots as plot (keyOf(plot))}
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
          onframe={() => recovery.presented()}
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

  /* Side by side while there is room; the 1px gap shows the border color as hairlines. */
  .monitor__lanes {
    display: grid;
    flex: 1;
    grid-template-columns: repeat(auto-fit, minmax(min(26rem, 100%), 1fr));
    grid-auto-rows: minmax(10rem, 1fr);
    gap: 1px;
    min-block-size: 0;
    overflow: auto;
    background: var(--color-border);
  }
</style>
