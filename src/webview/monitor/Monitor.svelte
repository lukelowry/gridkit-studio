<!-- One lane per plotted signal of the run on show, under the case's playback controls. -->
<script lang="ts">
  import type { Data, Domain } from '@latkit/model'
  import { onMount } from 'svelte'

  import { message } from '../../shared/format.js'
  import { type Begin, type Plot as Plotted, TAIL, type ViewState } from '../../shared/messages.js'
  import { fieldName, typeName } from '../../shared/schema.js'
  import { type ClockState, IDLE } from '../../shared/transport.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { CanvasGpu } from '../gpu.js'
  import { receive } from '../stream.js'
  import { appearance, font, palette, watchTheme } from '../theme.js'
  import Select from '../ui/Select.svelte'
  import { sameWindow, windowOf } from './plot.js'
  import Plot from './Plot.svelte'
  import Transport from './Transport.svelte'

  /** How long a window the user chose must rest before the extension hears of it. */
  const WINDOW_MS = 120

  let view = $state.raw<ViewState>({})
  /** The case with the run's frames so far. */
  let source = $state.raw<Data | undefined>()
  /** The times `source` holds; absent when it holds the whole run. */
  let held = $state.raw<Begin['held']>()
  /** The clock as of its last change. */
  let tick = $state.raw<ClockState>(IDLE)
  let live = $state(false)
  /** The playhead, updated every frame while playing. */
  let t = $state(0)
  let theme = $state.raw({ palette: palette(), font: font() })
  /** Bumped on GPU loss or retry, so every plot remounts. */
  let epoch = $state(0)
  let fault = $state<string | null>(null)
  /** Whether VS Code shows the view; a hidden view keeps its webview but stops drawing. */
  let visible = $state(true)
  let hidden = $state(document.hidden)
  const paused = $derived(!visible || hidden)
  /** The window the user chose, and the last one sent to the extension. */
  let chosen = $state.raw<Domain | undefined>()
  let told: Domain | undefined
  let telling: ReturnType<typeof setTimeout> | undefined

  const owner = new CanvasGpu()
  const gpu = () => owner.get(() => epoch++)
  const clock = createClock(
    (now) => (t = now),
    () => {
      tick = clock.state
      live = clock.live
    },
  )

  const run = $derived(view.run)
  const plots = $derived(view.plots ?? [])
  const running = $derived(run?.state === 'running')
  /** The window every plot shows: the user's, else the run's. A growing run's widens by doubling;
   *  a run held only in part shows its tail. */
  const shown = $derived.by((): Domain => {
    const window = chosen ?? view.window
    if (window) return window
    if (!run || !(run.domain[1] > run.domain[0]))
      return [run?.domain[0] ?? 0, (run?.domain[0] ?? 0) + 1]
    if (held) return [Math.max(run.domain[0], run.domain[1] - TAIL), run.domain[1]]
    // A running run with a known span shows all of it from its first frame.
    return running && run.span ? run.span : windowOf(run.domain, running)
  })
  /** The run in one line: name, state and sample count. */
  const about = $derived(
    run
      ? `${run.name} · ${run.state} · ${run.frames.toLocaleString()} samples`
      : (view.summary?.name ?? ''),
  )
  const warning = $derived(
    view.stale
      ? 'Source is updating or invalid. Results keep the case revision they were recorded for.'
      : run && view.summary && run.fingerprint !== view.summary.fingerprint
        ? 'These results belong to an earlier case revision.'
        : null,
  )
  /** The signals the run on show records, else those the next run will. */
  const signals = $derived.by(() => {
    const schema = view.summary?.schema
    if (!schema) return []
    return (run?.outputs ?? view.outputs ?? []).flatMap(({ from, select }) =>
      select.map((field) => ({
        value: { type: from, field },
        label: `${typeName(schema, from)} · ${fieldName(schema.types[from]?.fields[field], field)}`,
        group: typeName(schema, from),
      })),
    )
  })
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
          if (view.run?.id !== before.run?.id) chosen = told = undefined
          else if (!sameWindow(view.window, before.window) && !sameWindow(view.window, told))
            chosen = undefined
        } else if (incoming.kind === 'action') {
          if (incoming.command === 'shown') visible = incoming.value === true
          else if (incoming.command === 'resetMonitorWindow') chosen = told = undefined
          else if (incoming.command === 'retryMonitor') {
            fault = null
            epoch++
          } else if (incoming.command === 'error') fault = String(incoming.value)
        }
      }),
      receive(
        (data, begin) => {
          source = data
          held = begin.held
          fault = null
        },
        (reason) => (fault = message(reason)),
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
  <div class="monitor__head">
    <div class="monitor__signal">
      <Select
        label="Plots"
        options={signals}
        key={({ type, field }) => `${type}/${field}`}
        placeholder="Add plot"
        compact
        hideLabel
        disabled={signals.length === 0}
        data-testid="monitor-signal"
        bind:value={
          (): { type: string; field: string } | null => null,
          (signal) => {
            if (signal !== null && view.summary)
              bridge.command('plot', {
                uri: view.summary.uri,
                version: view.summary.version,
                origin: 'monitor',
                ...signal,
              })
          }
        }
      />
    </div>
    <p class="monitor__run" title={about}>{about}</p>
    {#if tick.status !== 'idle' && live && !tick.follow}
      <button
        type="button"
        class="c-btn"
        data-testid="monitor-go-live"
        onclick={() => clock.act({ action: 'goLive' })}
      >
        Go live
      </button>
    {/if}
    {#if run && tick.status !== 'idle'}
      <div class="monitor__playback">
        <Transport
          {clock}
          {tick}
          {t}
          {live}
          frames={run.frames}
          recorded={run.domain}
          axis={view.summary?.schema.axis}
        />
      </div>
    {/if}
  </div>
  {#if run?.message}
    <p class="c-note c-note--error" role="alert">{run.message}</p>
  {/if}
  {#if fault ?? view.error ?? warning}
    <p
      class={['c-note', fault || view.error ? 'c-note--error' : 'c-note--warn']}
      role={fault || view.error ? 'alert' : 'status'}
    >
      {fault ?? view.error ?? warning}
    </p>
  {/if}
  {#if plots.length === 0 || !run}
    <div class="c-empty monitor__empty">
      <p class="c-empty__text">
        {!view.summary
          ? 'Loading case…'
          : !run
            ? 'Run DynamicSimulation or import results to plot recorded signals.'
            : 'Choose a signal to plot it.'}
      </p>
      {#if view.summary}
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

  /* Styled as a panel header: the plot picker, the run as its title, then playback. */
  .monitor__head {
    display: flex;
    flex-wrap: wrap;
    flex-shrink: 0;
    align-items: center;
    gap: 0 var(--spacing-sm);
    min-block-size: var(--spacing-header-h);
    padding-inline: var(--spacing-md);
    border-block-end: 1px solid var(--color-border);
  }

  .monitor__signal {
    flex: 0 1 12rem;
    min-inline-size: 5rem;
  }

  .monitor__run {
    flex: 1 1 6rem;
    min-inline-size: 0;
    margin-inline-end: auto;
    overflow: hidden;
    color: var(--color-text-2);
    font-size: var(--text-xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .monitor__playback {
    min-inline-size: 0;
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

  /* Too narrow for one row: playback wraps to its own row. */
  @container monitor (max-width: 36rem) {
    .monitor__playback {
      order: 1;
      flex-basis: 100%;
    }

    .monitor__playback :global(.playback) {
      justify-content: flex-start;
    }
  }
</style>
