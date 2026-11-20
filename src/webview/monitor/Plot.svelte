<script lang="ts">
  import type { Gpu, Id, Tiles, View } from 'latkit'

  import type { ExactSample, TimeRange } from '../../shared/data.js'
  import { fieldDefinition, fieldKey, sameField } from '../../shared/document.js'
  import { formatNumber } from '../../shared/format.js'
  import type { Monitor, ViewState } from '../../shared/messages.js'
  import { monitorName } from '../../shared/monitors.js'
  import { reader } from '../../shared/settings.js'
  import { clamp } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import type { Clock } from '../clock.js'
  import type { CanvasView } from '../latkit/canvas.js'
  import { bindInteractions } from '../latkit/interactions.js'
  import LatkitCanvas from '../latkit/LatkitCanvas.svelte'
  import { refreshResults } from '../latkit/results.js'
  import { plotScene } from '../latkit/scenes.js'
  import { nativeTheme } from '../latkit/theme.js'
  import { contextOf, nativeMenu } from '../menu.js'
  import { plotCamera, sameWindow } from './plot.js'

  let {
    monitor,
    tiles,
    viewState,
    gpu,
    active,
    timeWindow,
    t,
    clock,
    themeVersion,
    register,
    onwindow,
    onerror,
  }: {
    monitor: Monitor
    tiles: Tiles
    viewState: ViewState
    gpu: Gpu
    active: boolean
    timeWindow: TimeRange
    t: number
    clock: Clock
    themeVersion: number
    /** Makes a view follow the playhead until the returned function is called. */
    register: (view: View) => () => void
    onwindow: (range: TimeRange) => void
    onerror: (error: unknown) => void
  } = $props()
  let plotView = $state.raw<View>()
  let hoveredId = $state<Id>()
  let traceIndex = $state(0)
  let sample = $state.raw<ExactSample>()
  let focused = $state(false)
  const name = $derived(monitorName(viewState.summary?.definition, monitor))
  const settings = $derived(reader(viewState.settings))
  const results = $derived(viewState.results)
  const output = $derived(results?.outputs.find((each) => sameField(each, monitor)))
  const recorded = $derived(!!output)
  const frames = $derived(results?.frames ?? 0)
  const ids = $derived(output?.ids ?? [])
  const scene = $derived.by(() => {
    void themeVersion
    return plotScene(tiles, monitor, settings, nativeTheme('monitor'))
  })
  const camera = $derived(plotCamera(monitor, timeWindow))
  const sampleId = $derived(hoveredId ?? monitor.id ?? ids[Math.min(traceIndex, ids.length - 1)])
  const unit = $derived(
    viewState.summary
      ? fieldDefinition(viewState.summary.definition, monitor.table, monitor.field)?.unit
      : undefined,
  )
  /** The hovered or focused trace's value at the playhead. */
  const reading = $derived.by(() => {
    if (!sample || (!focused && hoveredId === undefined)) return ''
    const value =
      sample.value === null
        ? 'No value'
        : [formatNumber(sample.value), unit].filter(Boolean).join(' ')
    return `${String(sampleId)}: ${value} at ${formatNumber(sample.at)} s`
  })

  $effect(() => refreshResults(tiles, frames))
  $effect(() => {
    if (plotView) plotView.camera = camera
  })
  $effect(() => {
    if (!plotView) return
    const selected = viewState.selection
    plotView.selection =
      selected?.table === monitor.table && ids.includes(selected.id)
        ? [{ data: tiles.name, table: monitor.table, ids: [selected.id] }]
        : []
  })
  $effect(() => {
    if (!active || !results || sampleId === undefined || (!focused && hoveredId === undefined))
      return
    const controller = new AbortController()
    const request = {
      results: results.id,
      table: monitor.table,
      field: monitor.field,
      id: sampleId,
      at: t,
    }
    const timer = setTimeout(() => {
      void bridge.request('sample', request, controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) sample = next
        },
        (error: unknown) => {
          if (!controller.signal.aborted) onerror(error)
        },
      )
    }, 75)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  })

  function fetched(view: View): [number, number] | null | undefined {
    const snapshot = view.snapshot(tiles.name)
    try {
      return snapshot?.describe().span
    } finally {
      snapshot?.destroy()
    }
  }

  function ready({ view, canvas }: CanvasView) {
    plotView = view
    const disconnect = bindInteractions(view, canvas, {
      select(element) {
        bridge.send({
          kind: 'select',
          element: element ? { ...element, field: monitor.field } : null,
        })
      },
      open: (element) =>
        bridge.send({ kind: 'open', element: { ...element, field: monitor.field } }),
      menu: (point, element) =>
        nativeMenu(canvas, point, contextOf(viewState, 'monitor', element, monitor)),
      camera(next) {
        if ('x' in next && !sameWindow(next.x, timeWindow)) onwindow(next.x)
      },
      error: onerror,
    })
    const hover = view.on('hovered', ({ hit }) => {
      hoveredId = hit?.row.id
    })
    const unregister = register(view)
    const seek = (event: PointerEvent) => {
      if (
        event.buttons ||
        event.pointerType === 'touch' ||
        clock.state.status !== 'paused' ||
        clock.state.follow
      )
        return
      const point = view.position([event.offsetX, event.offsetY])
      if (point) clock.seek(clamp(point[0], clock.state.span))
    }
    canvas.addEventListener('pointermove', seek)
    const hooks = canvas as HTMLCanvasElement & {
      gridkitPlot?: () => unknown
      gridkitPoint?: (at: number, value: number) => unknown
      gridkitRead?: (point: [number, number]) => unknown
    }
    hooks.gridkitPlot = () => ({
      ...view.stats,
      motion: typeof view.scene.controls === 'object' ? view.scene.controls.motion : undefined,
      complete: view.complete,
      waiting: view.waiting,
      selection: view.selection,
      hovered: view.hovered,
      span: fetched(view),
      camera: view.camera,
      at: view.at,
      work: gpu.work,
      resident: gpu.resident,
      uploading: gpu.uploading,
    })
    hooks.gridkitPoint = (at, value) => view.screen([at, value, 0])
    hooks.gridkitRead = (point) => view.pick(point)
    return () => {
      unregister()
      disconnect()
      hover()
      canvas.removeEventListener('pointermove', seek)
      delete hooks.gridkitPlot
      delete hooks.gridkitPoint
      delete hooks.gridkitRead
      if (plotView === view) plotView = undefined
    }
  }
  /** Plot keys. Keys with Control, Command or Alt are left to VS Code, which switches monitors with
   *  Control+Page Up and Page Down as the Terminal switches terminals. */
  function keydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      traceIndex = Math.max(
        0,
        Math.min(ids.length - 1, traceIndex + (event.key === 'PageUp' ? -1 : 1)),
      )
      hoveredId = undefined
    } else if (event.key === ' ') clock.act({ action: 'playPause' })
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      clock.act({ action: 'step', value: event.key === 'ArrowLeft' ? -1 : 1 })
    else if (event.key === 'Home' && results?.domain) {
      if (monitor.range) bridge.send({ kind: 'fitValues', monitor })
      onwindow(results.domain)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (The native canvas supplies keyboard focus.) -->
<section
  class="plot"
  aria-label={name}
  data-monitor={fieldKey(monitor)}
  onkeydowncapture={keydown}
  onfocusin={() => (focused = true)}
  onfocusout={() => (focused = false)}
>
  {#if recorded && frames}
    <LatkitCanvas
      {gpu}
      {scene}
      sources={[tiles]}
      {active}
      {camera}
      onready={ready}
      {onerror}
      label={`${name}. Page Up and Page Down read traces. Space plays or pauses. Left and Right step samples.`}
    />
    {#if reading}
      <output class="plot__reading" aria-live={clock.state.status === 'playing' ? 'off' : 'polite'}>
        {reading}
      </output>
    {/if}
  {:else}
    <div class="c-empty"><p class="c-empty__text">Waiting for samples…</p></div>
  {/if}
</section>

<style>
  .plot {
    position: relative;
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 0;
    background: var(--color-surface-1);
  }

  .plot__reading {
    position: absolute;
    inset-block-start: var(--spacing-xs);
    inset-inline-end: var(--spacing-sm);
    max-inline-size: calc(100% - 2 * var(--spacing-sm));
    overflow: hidden;
    padding: 0 var(--spacing-xs);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--color-bg) 85%, transparent);
    color: var(--color-text-2);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }
</style>
