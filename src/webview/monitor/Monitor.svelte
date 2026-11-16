<script lang="ts">
  import type { View } from 'latkit'
  import { onMount, tick } from 'svelte'

  import type { TimeRange } from '../../shared/data.js'
  import type { Monitor, ViewState } from '../../shared/messages.js'
  import { reader } from '../../shared/settings.js'
  import { bridge } from '../bridge.js'
  import { createClock } from '../clock.js'
  import { imageOptions, picture, saveImage } from '../export/image.js'
  import { plotViews } from '../export/plots.js'
  import { LatkitPage } from '../latkit/page.svelte.js'
  import { nativeTheme } from '../latkit/theme.js'
  import MonitorList, { LIST_WIDTH } from './MonitorList.svelte'
  import { monitorWindow, sameWindow, SETTLE_MS } from './plot.js'
  import Plot from './Plot.svelte'

  const page = new LatkitPage((error) => bridge.report(error))
  const fail = page.fail
  let viewState = $state.raw<ViewState>({})
  let t = $state(0)
  let chosenWindow = $state.raw<TimeRange>()
  let listWidth = $state(bridge.state<{ listWidth?: number }>({}).listWidth ?? LIST_WIDTH)
  let area = $state<HTMLElement>()
  let areaSize = $state<readonly [number, number]>([0, 0])
  const views = new Set<View>()
  const lifetime = new AbortController()
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  const active = $derived(page.active)
  const results = $derived(viewState.results)
  const monitors = $derived(viewState.monitors ?? [])
  const shown = $derived(viewState.shown ?? [])
  /** Split plots sit side by side in a wide panel, as the Terminal splits in the bottom panel, and
   *  stack in a tall one. */
  const direction = $derived(areaSize[0] >= 2 * areaSize[1] ? 'row' : 'column')
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

  $effect(() => bridge.save({ listWidth }))
  $effect(() => {
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) areaSize = [entry.contentRect.width, entry.contentRect.height]
    })
    observer.observe(area)
    return () => observer.disconnect()
  })

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
  /** Shows `monitor` and moves the keyboard to its plot. */
  async function open(monitor: Monitor) {
    bridge.send({ kind: 'showMonitor', monitor })
    await tick()
    // The plot appears once the extension shows it; wait a frame for its canvas.
    requestAnimationFrame(() =>
      area
        ?.querySelector<HTMLElement>(
          `[data-monitor="${CSS.escape(`${monitor.table}.${monitor.field}`)}"] canvas`,
        )
        ?.focus(),
    )
  }
  /** Exports the plots as the Monitor shows them. */
  async function exportImage() {
    const gpu = page.gpu
    if (!gpu || !results || !viewState.uri || !viewState.summary || !area) return
    const settings = reader(viewState.settings)
    const options = imageOptions(viewState.exportSettings)
    const plots = await plotViews(
      viewState,
      results,
      gpu,
      timeWindow,
      [0, 0, 1, 1],
      lifetime.signal,
      {
        theme: nativeTheme(settings, 'monitor'),
        direction,
      },
    )
    try {
      for (const { view } of plots.placed) view.at = t
      await saveImage(
        picture([area.clientWidth, area.clientHeight], plots.placed, options),
        viewState.uri,
        viewState.summary.name,
        'monitor',
        options,
        lifetime.signal,
      )
    } finally {
      plots.release()
    }
  }
  /** The Terminal's keys for its terminals, here for the monitors: Control+Page Up and Page Down
   *  (Command+Shift+[ and ] on macOS) show the previous or next, and Control+Shift+5 (Command+\)
   *  splits. */
  function keys(event: KeyboardEvent) {
    const mac = navigator.userAgent.includes('Mac')
    if (event.altKey || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey))
      return
    const step = mac
      ? event.shiftKey && event.code === 'BracketLeft'
        ? -1
        : event.shiftKey && event.code === 'BracketRight'
          ? 1
          : 0
      : !event.shiftKey && event.key === 'PageUp'
        ? -1
        : !event.shiftKey && event.key === 'PageDown'
          ? 1
          : 0
    if (step) bridge.send({ kind: 'cycleMonitor', step })
    else if (
      mac
        ? !event.shiftKey && event.code === 'Backslash'
        : event.shiftKey && event.code === 'Digit5'
    )
      bridge.send({ kind: 'splitMonitor' })
    else return
    event.preventDefault()
    event.stopPropagation()
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
    // Before the plots' own keys, which leave these alone.
    window.addEventListener('keydown', keys, { capture: true })
    const hooks = window as Window & { gridkitMonitor?: () => unknown }
    hooks.gridkitMonitor = () => ({
      views: views.size,
      monitors: monitors.length,
      shown: shown.length,
      direction,
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
      window.removeEventListener('keydown', keys, { capture: true })
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
  {#if !viewState.uri}
    <div class="c-empty monitor__empty"><p class="c-empty__text">Open a GridKit case.</p></div>
  {:else if !viewState.summary}
    <div class="c-empty monitor__empty"><p class="c-empty__text">Loading case…</p></div>
  {:else if !monitors.length}
    <div class="c-empty monitor__empty">
      <p class="c-empty__text">
        {results?.outputs.length === 0 && results.frames
          ? 'These results hold no signals.'
          : 'The case records no signals. Add signals to the mon lists of its elements.'}
      </p>
    </div>
  {:else}
    <div
      class="monitor__plots"
      class:monitor__plots--row={direction === 'row'}
      data-testid="monitor-plots"
      bind:this={area}
    >
      {#if !results}
        <div class="c-empty monitor__empty">
          <p class="c-empty__text">
            Right-click a .solver.json and choose Run Dynamic Simulation to see its results here.
          </p>
        </div>
      {:else if page.gpu}
        {#each shown as monitor (JSON.stringify( [results.id, monitor.table, monitor.field, monitor.id] ))}
          <Plot
            {monitor}
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
      {/if}
    </div>
    <MonitorList
      {viewState}
      bind:width={listWidth}
      onshow={(monitor) => bridge.send({ kind: 'showMonitor', monitor })}
      onsplit={(monitor) => bridge.send({ kind: 'splitMonitor', monitor })}
      onunsplit={(monitor) => bridge.send({ kind: 'unsplitMonitor', monitor })}
      onopen={(monitor) => void open(monitor)}
    />
  {/if}
</div>

<style>
  .monitor {
    display: flex;
    block-size: 100%;
    min-block-size: 0;
    overflow: hidden;
  }

  .monitor__empty {
    flex: 1;
  }

  .monitor__plots {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 0;
  }

  .monitor__plots--row {
    flex-direction: row;
  }

  /* Split plots are divided as split terminals are. */
  .monitor__plots :global(.plot + .plot) {
    border-block-start: 1px solid var(--color-border);
  }

  .monitor__plots--row :global(.plot + .plot) {
    border-block-start: 0;
    border-inline-start: 1px solid var(--color-border);
  }
</style>
