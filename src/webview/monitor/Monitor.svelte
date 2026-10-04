<!-- Plot the recorded signals of the run on show, one lane each, under the case's playback controls. -->
<script lang="ts">
  import type { Data, Domain } from '@latkit/model'
  import { onMount } from 'svelte'

  import { type Begin, type Plot as Plotted, TAIL, type ViewState } from '../../messages.js'
  import { type ClockState, IDLE } from '../../transport.js'
  import { bridge, merged } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { CanvasGpu } from '../gpu.js'
  import { receive } from '../stream.js'
  import { appearance, font, palette, watchTheme } from '../theme.js'
  import Icon from '../ui/Icon.svelte'
  import { windowOf } from './plot.js'
  import Plot from './Plot.svelte'
  import Transport from './Transport.svelte'

  /** How long the plots rest at other times before the extension hears of them. */
  const WINDOW_MS = 120

  let view = $state.raw<ViewState>({})
  /** The case with the run's frames so far, and the times of the run it holds; none is all of it. */
  let source = $state.raw<Data | undefined>()
  let held = $state.raw<Begin['held']>()
  /** The clock as of its last change, and the playhead, refreshed every frame while it plays. */
  let tick = $state.raw<ClockState>(IDLE)
  let live = $state(false)
  let t = $state(0)
  let theme = $state.raw({ palette: palette(), font: font() })
  /** Grows each time the GPU stops, so every plot draws again on a new one. */
  let epoch = $state(0)
  let fault = $state<string | null>(null)
  let paused = $state(document.hidden)
  /** The times the reader turned the plots to, and the ones the extension was last told. */
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
  /** The times every plot shows: the reader's, or else the run, of which a growing one shows a
   *  window that widens by doubling; a run held only in part shows its tail. */
  const shown = $derived.by((): Domain => {
    const window = chosen ?? view.window
    if (window) return window
    if (!run || !(run.domain[1] > run.domain[0]))
      return [run?.domain[0] ?? 0, (run?.domain[0] ?? 0) + 1]
    if (held) return [Math.max(run.domain[0], run.domain[1] - TAIL), run.domain[1]]
    return windowOf(run.domain, running)
  })
  /** The run in a line: what it is, how it stands, and how much of it there is. */
  const about = $derived(
    run
      ? `${run.name} · ${run.state} · ${run.frames.toLocaleString()} frames`
      : (view.summary?.name ?? ''),
  )
  const warning = $derived(
    view.stale
      ? 'Source is updating or invalid. Results keep the case revision they were recorded for.'
      : run && view.summary && run.fingerprint !== view.summary.fingerprint
        ? 'These results belong to an earlier case revision.'
        : null,
  )
  const same = (a: Domain | undefined, b: Domain | undefined) =>
    a?.[0] === b?.[0] && a?.[1] === b?.[1]
  const keyOf = (plot: Plotted) => `${plot.from}\n${plot.field}\n${plot.id ?? ''}`

  /** The reader turned a plot to `bounds`: every plot follows, and the extension hears once they rest. */
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
      bridge.on((message) => {
        if (message.kind === 'state') {
          const before = view
          view = merged(view, message.state)
          appearance(view.settings)
          // Another run starts at its own times; times the extension chose replace the reader's.
          if (view.run?.id !== before.run?.id) chosen = told = undefined
          else if (!same(view.window, before.window) && !same(view.window, told)) chosen = undefined
        } else if (message.kind === 'action') {
          if (message.command === 'resetMonitorWindow') chosen = told = undefined
          else if (message.command === 'retryMonitor') {
            fault = null
            epoch++
          } else if (message.command === 'error') fault = String(message.value)
        }
      }),
      receive(
        (data, begin) => {
          source = data
          held = begin.held
          fault = null
        },
        (reason) => (fault = reason instanceof Error ? reason.message : String(reason)),
      ),
      watchTheme(() => (theme = { palette: palette(), font: font() })),
    ]
    const visibility = () => (paused = document.hidden)
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
    <button
      type="button"
      class="c-btn monitor__add"
      title="Plot a recorded signal"
      data-testid="monitor-add"
      onclick={() => bridge.command('plot')}
    >
      <Icon name="plus" />Signal
    </button>
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
  {#if fault ?? warning}
    <p
      class={['c-note', fault ? 'c-note--error' : 'c-note--warn']}
      role={fault ? 'alert' : 'status'}
    >
      {fault ?? warning}
    </p>
  {/if}
  {#if plots.length === 0 || !run}
    <div class="c-empty monitor__empty">
      <p class="c-empty__text">
        {!view.summary
          ? 'Loading case…'
          : !run
            ? 'Run the study or import results to plot recorded signals.'
            : 'Choose a signal to plot it.'}
      </p>
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

  /* The head is a panel's header: the run where the title stands, then the playback. */
  .monitor__head {
    display: flex;
    flex-wrap: wrap;
    flex-shrink: 0;
    align-items: center;
    gap: 0 var(--spacing-sm);
    min-block-size: var(--spacing-header-h);
    padding-inline: var(--spacing-xs) var(--spacing-md);
    border-block-end: 1px solid var(--color-border);
  }

  .monitor__add {
    flex: 0 0 auto;
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

  /* One lane a signal, side by side while there is room, joined by a hairline. */
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

  /* Too narrow for one row: the playback takes a row of its own under the run. */
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
