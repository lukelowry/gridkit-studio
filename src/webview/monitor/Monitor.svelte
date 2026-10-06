<!-- One lane per plotted signal of the run on show. Plots are added from the view's title bar,
  which also names the run, and played from the status bar. -->
<script lang="ts">
  import type { Data, Domain, FieldSelection } from '@latkit/model'
  import { onMount } from 'svelte'

  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { type ClockState, IDLE } from '../../shared/transport.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { CanvasGpu, RECOVER_MS } from '../gpu.js'
  import { receive } from '../stream.js'
  import { appearance, font, palette, watchTheme } from '../theme.js'
  import { monitorWindow, sameWindow } from './plot.js'
  import Plot from './Plot.svelte'

  /** How long a window the user chose must rest before the extension hears of it. */
  const WINDOW_MS = 120

  let view = $state.raw<ViewState>({})
  /** The case with the run's frames so far. */
  let source = $state.raw<Data | undefined>()
  /** The fields, and their rows, whose samples `source` holds. */
  let sampled = $state.raw<readonly FieldSelection[]>([])
  /** The clock as of its last change. */
  let tick = $state.raw<ClockState>(IDLE)
  /** The playhead, updated every frame while playing. */
  let t = $state(0)
  let theme = $state.raw({ palette: palette(), font: font() })
  /** Bumped on GPU loss or retry, so every plot remounts. */
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
  /** When the GPU was last replaced: one lost again soon after waits for Reload Monitor. */
  let recovered = -Infinity
  const gpu = () =>
    owner.get(() => {
      if (performance.now() - recovered < RECOVER_MS) {
        bridge.report('WebGPU device lost.')
        return
      }
      recovered = performance.now()
      epoch++
    })
  const clock = createClock(
    (now) => (t = now),
    () => (tick = clock.state),
  )

  const run = $derived(view.run)
  const plots = $derived(view.plots ?? [])
  const shown = $derived(monitorWindow(run, chosen ?? view.window))
  const warning = $derived(
    view.stale
      ? 'Source is updating or invalid. Results keep the case revision they were recorded for.'
      : run && view.summary && run.fingerprint !== view.summary.fingerprint
        ? 'These results belong to an earlier case revision.'
        : null,
  )
  const keyOf = (plot: Plotted) => `${plot.from}\n${plot.field}\n${plot.id ?? ''}`

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
          // Another run resets the window; one the extension set replaces the user's.
          if (view.run?.id !== before.run?.id) {
            clearTimeout(telling)
            chosen = told = undefined
            source = undefined
            sampled = []
          } else if (!sameWindow(view.window, before.window) && !sameWindow(view.window, told))
            chosen = undefined
        } else if (incoming.kind === 'action') {
          if (incoming.command === 'shown') visible = incoming.value === true
          else if (incoming.command === 'resetMonitorWindow') chosen = told = undefined
          else if (incoming.command === 'retryMonitor') {
            recovered = -Infinity
            epoch++
          }
        }
      }),
      receive(
        (data, begin) => {
          if (begin.simulationId !== view.run?.id) return
          source = data
          sampled = begin.sampled
        },
        (reason) => bridge.report(reason),
      ),
      watchTheme(() => (theme = { palette: palette(), font: font() })),
    ]
    const visibility = () => (hidden = document.hidden)
    document.addEventListener('visibilitychange', visibility)
    bridge.send({ kind: 'ready' })
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      clearTimeout(telling)
      for (const stop of stops) stop()
      clock.stop()
      owner.dispose()
    }
  })
</script>

<div class="monitor">
  {#if warning}
    <p class="c-note c-note--warn" role="status">{warning}</p>
  {/if}
  {#if plots.length === 0 || !run}
    <div class="c-empty monitor__empty">
      <p class="c-empty__text">
        {!view.summary
          ? 'Loading case…'
          : !run
            ? 'Start a simulation or import results to plot recorded signals.'
            : 'Add a plot from the title bar to see a recorded signal.'}
      </p>
      {#if view.summary && !run}
        <button class="c-btn" onclick={() => bridge.command('chooseSignals')}>
          Choose monitored signals
        </button>
      {/if}
    </div>
  {:else}
    <div class="monitor__lanes" data-testid="monitor-lanes">
      {#each plots as plot (keyOf(plot))}
        {#key epoch}
          <Plot
            {plot}
            {view}
            {source}
            {sampled}
            {t}
            {shown}
            {theme}
            {clock}
            {tick}
            {gpu}
            {paused}
            onwindow={turn}
          />
        {/key}
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
