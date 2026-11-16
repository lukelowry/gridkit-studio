<script lang="ts">
  import type { Gpu, Id, View } from 'latkit'
  import { untrack } from 'svelte'

  import type { ExactSample, TimeRange } from '../../shared/data.js'
  import { fieldDefinition } from '../../shared/document.js'
  import { formatNumber } from '../../shared/format.js'
  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { isRecorded, plotName } from '../../shared/plots.js'
  import { reader } from '../../shared/settings.js'
  import { clamp } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import type { Clock } from '../clock.js'
  import type { CanvasView } from '../latkit/canvas.js'
  import { bindInteractions } from '../latkit/interactions.js'
  import LatkitCanvas from '../latkit/LatkitCanvas.svelte'
  import { refresher, resultTiles } from '../latkit/results.js'
  import { plotScene } from '../latkit/scenes.js'
  import { nativeTheme } from '../latkit/theme.js'
  import { nativeMenu } from '../menu.js'
  import Icon from '../ui/Icon.svelte'
  import { plotCamera, sameWindow } from './plot.js'

  let {
    plot,
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
    plot: Plotted
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
  // The Monitor recreates a plot for new results, so its tiles stay fixed for its lifetime.
  const tiles = untrack(() => resultTiles(viewState.results!.id, plot.table, plot.field, plot.id))
  let plotView = $state.raw<View>()
  let lifetime = new AbortController()
  let visible = $state(true)
  let hoveredId = $state<Id>()
  let traceIndex = $state(0)
  let sample = $state.raw<ExactSample>()
  let focused = $state(false)
  const title = $derived(plotName(viewState.summary?.definition, plot))
  const settings = $derived(reader(viewState.settings))
  const results = $derived(viewState.results)
  const recorded = $derived(isRecorded(results, plot))
  const frames = $derived(results?.frames ?? 0)
  const ids = $derived(
    results?.outputs.find((output) => output.table === plot.table && output.field === plot.field)
      ?.ids ?? [],
  )
  const enabled = $derived(active && visible)
  const scene = $derived.by(() => {
    void themeVersion
    return plotScene(tiles, plot, settings, nativeTheme(settings, 'monitor'))
  })
  const camera = $derived(plotCamera(plot, timeWindow))
  const sampleId = $derived(hoveredId ?? plot.id ?? ids[Math.min(traceIndex, ids.length - 1)])
  const unit = $derived(
    viewState.summary
      ? fieldDefinition(viewState.summary.definition, plot.table, plot.field)?.unit
      : undefined,
  )
  /** The hovered or focused trace's value at the playhead. */
  const reading = $derived.by(() => {
    if (!sample || (!focused && hoveredId === undefined)) return ''
    const value = sample.value === null ? 'No value' : formatNumber(sample.value)
    return `${String(sampleId)}: ${value}${unit ? ` ${unit}` : ''} · ${formatNumber(sample.at)} s`
  })

  function observe(element: HTMLElement) {
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry) visible = entry.isIntersecting
    })
    intersection.observe(element)
    return () => intersection.disconnect()
  }

  /** Refetches the tiles as the run records more, each time after the last refresh has drawn. */
  const grow = refresher(tiles, () => plotView?.done({ signal: lifetime.signal }))
  let refreshed = untrack(() => frames)
  $effect(() => {
    if (frames === refreshed) return
    refreshed = frames
    untrack(grow)
  })
  $effect(() => {
    if (plotView) plotView.camera = camera
  })
  let unregister: (() => void) | undefined
  // A plot scrolled out of view keeps its view, which follows the playhead again once it returns.
  $effect(() => {
    const view = plotView
    if (!view || !visible) return
    const off = (unregister = untrack(() => register(view)))
    return () => {
      off()
      if (unregister === off) unregister = undefined
    }
  })
  $effect(() => {
    if (!plotView) return
    const selected = viewState.selection
    plotView.selection =
      selected?.table === plot.table && ids.includes(selected.id)
        ? [{ data: tiles.name, table: plot.table, ids: [selected.id] }]
        : []
  })
  $effect(() => {
    if (!enabled || !results || sampleId === undefined || (!focused && hoveredId === undefined))
      return
    const controller = new AbortController()
    const request = {
      results: results.id,
      table: plot.table,
      field: plot.field,
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
    lifetime = new AbortController()
    const disconnect = bindInteractions(view, canvas, {
      select(element) {
        bridge.send({ kind: 'select', element: element ? { ...element, field: plot.field } : null })
      },
      open: (element) => bridge.send({ kind: 'open', element: { ...element, field: plot.field } }),
      menu: (point, element) => nativeMenu(canvas, point, element, viewState, 'monitor', plot),
      camera(next) {
        if ('x' in next && !sameWindow(next.x, timeWindow)) onwindow(next.x)
      },
      error: onerror,
    })
    const hover = view.on('hovered', ({ hit }) => {
      hoveredId = hit?.row.id
    })
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
      lifetime.abort()
      unregister?.()
      disconnect()
      hover()
      canvas.removeEventListener('pointermove', seek)
      delete hooks.gridkitPlot
      delete hooks.gridkitPoint
      delete hooks.gridkitRead
      if (plotView === view) plotView = undefined
    }
  }
  function keydown(event: KeyboardEvent) {
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
      if (plot.range) bridge.send({ kind: 'fitValues', plot })
      onwindow(results.domain)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<section class="lane" aria-label={title} {@attach observe}>
  <header class="lane__head">
    <h2 class="lane__name">{title}</h2>
    <output class="lane__reading" aria-live={clock.state.status === 'playing' ? 'off' : 'polite'}>
      {reading}
    </output>
    <button
      class="c-icon-btn lane__close"
      title="Remove Plot"
      aria-label={`Remove ${title}`}
      onclick={() => bridge.send({ kind: 'removePlot', plot })}
    >
      <Icon name="close" />
    </button>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions (The native canvas supplies keyboard focus.) -->
  <div
    class="lane__surface"
    onkeydowncapture={keydown}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    {#if recorded && frames}
      <LatkitCanvas
        {gpu}
        {scene}
        sources={[tiles]}
        at={visible ? t : undefined}
        {active}
        {camera}
        onready={ready}
        {onerror}
        label={`${title}. Page Up and Page Down read traces. Space plays or pauses. Left and Right step samples.`}
      />
    {:else if recorded}
      <div class="c-empty"><p class="c-empty__text">Waiting for samples…</p></div>
    {/if}
  </div>
</section>

<style>
  .lane {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 9rem;
    background: var(--color-surface-1);
  }
  .lane__head {
    display: flex;
    gap: var(--spacing-xs);
    align-items: baseline;
    padding: var(--spacing-2xs) var(--spacing-sm) 0;
    color: var(--color-text-2);
    font-size: var(--text-sm);
  }
  .lane__name {
    overflow: hidden;
    margin: 0;
    color: var(--color-text-1);
    font-size: inherit;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .lane__reading {
    overflow: hidden;
    margin-inline-start: auto;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .lane__close {
    align-self: center;
  }
  .lane__surface {
    position: relative;
    flex: 1;
    min-block-size: 0;
  }
</style>
