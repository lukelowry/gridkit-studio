<script lang="ts">
  import type { Camera, Data, Gpu, Id, View } from 'latkit'
  import { onMount, untrack } from 'svelte'

  import type { ExactSample, TimeRange } from '../../shared/data.js'
  import { fieldDefinition } from '../../shared/document.js'
  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { holdsPlot, plotName, samePlot } from '../../shared/plots.js'
  import { reader } from '../../shared/preferences.js'
  import { clamp } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import type { Clock } from '../clock.js'
  import { FrameReads, FrameWindow } from '../frames.js'
  import { bindInteractions } from '../interactions.js'
  import { nativeMenu } from '../menu.js'
  import { plotScene } from '../scenes.js'
  import { nativeTheme } from '../theme.js'
  import Icon from '../ui/Icon.svelte'
  import LatkitCanvas from '../ui/LatkitCanvas.svelte'
  import { type PlotState, sameWindow } from './plot.js'

  let {
    plot,
    kept,
    app,
    gpu,
    reads,
    active,
    shown,
    t,
    clock,
    themeVersion,
    budget,
    register,
    onwindow,
    onerror,
  }: {
    plot: Plotted
    kept: PlotState
    app: ViewState
    gpu: Gpu
    reads: FrameReads
    active: boolean
    shown: TimeRange
    t: number
    clock: Clock
    themeVersion: number
    budget: number
    register: (view: View) => () => void
    onwindow: (range: TimeRange) => void
    onerror: (error: unknown) => void
  } = $props()
  const frames = new FrameWindow(untrack(() => reads))
  let source = $state.raw<Data>()
  let native = $state.raw<View>()
  let width = $state(800)
  let visible = $state(true)
  let camera = $state.raw<Camera | undefined>(untrack(() => kept.camera))
  let valueRange = $state.raw<TimeRange | null>(untrack(() => kept.range ?? null))
  let inspected = $state<Id>()
  let trace = $state(0)
  let exact = $state.raw<ExactSample>()
  let focused = $state(false)
  let failed = $state(false)
  const title = $derived(plotName(app.summary?.definition, plot))
  const settings = $derived(reader(app.settings))
  const results = $derived(app.results)
  const recorded = $derived(holdsPlot(results, plot))
  const ids = $derived(
    results?.outputs.find((output) => output.table === plot.from && output.field === plot.field)
      ?.ids ?? [],
  )
  const enabled = $derived(active && visible)
  const scene = $derived.by(() => {
    void themeVersion
    return source
      ? plotScene(source, plot.from, plot.field, title, settings, nativeTheme(settings, 'monitor'))
      : undefined
  })
  const sampleId = $derived(inspected ?? plot.id ?? ids[Math.min(trace, ids.length - 1)])
  const unit = $derived(
    app.summary ? fieldDefinition(app.summary.definition, plot.from, plot.field)?.unit : undefined,
  )

  function observe(element: HTMLElement) {
    const size = new ResizeObserver(([entry]) => {
      if (entry) width = Math.max(1, Math.round(entry.contentRect.width))
    })
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry) visible = entry.isIntersecting
    })
    size.observe(element)
    intersection.observe(element)
    return () => {
      size.disconnect()
      intersection.disconnect()
    }
  }

  $effect(() => {
    if (!enabled || !results?.frames || !recorded) return
    const controller = new AbortController()
    failed = false
    void frames
      .plot(
        {
          results: results.id,
          table: plot.from,
          field: plot.field,
          ...(plot.id !== undefined ? { ids: [plot.id] } : {}),
          range: shown,
          purpose: 'plot',
          pixels: width,
          bytes: budget,
        },
        results.frames,
        controller.signal,
      )
      .then(
        (changed) => {
          if (changed && !controller.signal.aborted) source = frames.data
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            failed = true
            onerror(error)
          }
        },
      )
    return () => controller.abort()
  })
  $effect(() => {
    if (native) native.camera = { x: [...shown], y: valueRange ? [...valueRange] : null }
  })
  $effect(() => {
    if (!native || !source) return
    const selected = app.selection
    native.selection =
      selected?.table === plot.from && ids.includes(selected.id)
        ? [{ data: source.name, table: plot.from, ids: [selected.id] }]
        : []
  })
  $effect(() => {
    if (!enabled || !results || sampleId === undefined || (!focused && inspected === undefined))
      return
    const controller = new AbortController()
    const request = {
      results: results.id,
      table: plot.from,
      field: plot.field,
      id: sampleId,
      at: t,
    }
    const timer = setTimeout(() => {
      void bridge.request('sample', request, controller.signal).then(
        (sample) => {
          if (!controller.signal.aborted) exact = sample
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

  function ready(view: View, canvas: HTMLCanvasElement) {
    native = view
    view.camera = { x: [...shown], y: valueRange ? [...valueRange] : null }
    const unregister = register(view)
    const disconnect = bindInteractions(view, {
      select(element) {
        bridge.send({ kind: 'select', element: element ? { ...element, field: plot.field } : null })
      },
      open(element) {
        bridge.send({ kind: 'select', element: { ...element, field: plot.field } })
        bridge.command('revealInSource')
      },
      menu: (point, elements) =>
        nativeMenu(
          canvas,
          point,
          elements.map((element) => ({ ...element, field: plot.field })),
          app,
          'monitor',
          plot,
        ),
      camera(next) {
        camera = next
        kept.camera = next
        if ('x' in next && !sameWindow(next.x, shown)) onwindow(next.x)
      },
      error: onerror,
    })
    const hover = view.on('hovered', ({ hit }) => {
      inspected = hit?.row.id
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
    const stop = (event: Event) => event.stopPropagation()
    canvas.addEventListener('pointermove', seek)
    canvas.addEventListener('contextmenu', stop)
    const hooks = canvas as HTMLCanvasElement & {
      gridkitPlot?: () => unknown
      gridkitPoint?: (at: number, value: number) => unknown
      gridkitRead?: (point: [number, number]) => unknown
    }
    hooks.gridkitPlot = () => ({
      ...view.stats,
      motion: typeof view.scene.controls === 'object' ? view.scene.controls.motion : undefined,
      complete: view.complete,
      selection: view.selection,
      hovered: view.hovered,
      span: source?.describe().span,
      camera: view.camera,
      at: view.at,
      work: gpu.work,
      resident: gpu.resident,
      uploading: gpu.uploading,
    })
    hooks.gridkitPoint = (at, value) => view.screen([at, value, 0])
    hooks.gridkitRead = (point) => view.pick(point)
    return () => {
      kept.camera = camera
      unregister()
      disconnect()
      hover()
      canvas.removeEventListener('pointermove', seek)
      canvas.removeEventListener('contextmenu', stop)
      delete hooks.gridkitPlot
      delete hooks.gridkitPoint
      delete hooks.gridkitRead
      if (native === view) native = undefined
    }
  }
  function key(event: KeyboardEvent) {
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      trace = Math.max(0, Math.min(ids.length - 1, trace + (event.key === 'PageUp' ? -1 : 1)))
      inspected = undefined
    } else if (event.key === ' ') clock.act({ action: 'playPause' })
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      clock.act({ action: 'step', value: event.key === 'ArrowLeft' ? -1 : 1 })
    else if (event.key === 'Home' && results?.domain) {
      valueRange = null
      onwindow(results.domain)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind !== 'action' || message.command !== 'valueRange') return
      const value = message.value as { plot: Plotted; range: TimeRange | null }
      if (samePlot(value.plot, plot)) {
        valueRange = value.range
        kept.range = value.range
      }
    })
    return () => {
      off()
      frames.clear()
    }
  })
</script>

<section class="lane" aria-label={title} {@attach observe}>
  <header class="lane__head">
    <h2 class="lane__name">{title}</h2>
    <span class="lane__count">{plot.id !== undefined ? 1 : ids.length} traces</span>
    <button
      class="c-icon-button lane__close"
      title="Remove plot"
      aria-label={`Remove ${title}`}
      onclick={() =>
        bridge.command('removePlot', {
          uri: app.uri,
          version: app.summary?.version,
          origin: 'monitor',
          plot,
        })}
    >
      <Icon name="close" />
    </button>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions (The native canvas supplies keyboard focus.) -->
  <div
    class="lane__surface"
    onkeydowncapture={key}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    {#if scene && source}
      <LatkitCanvas
        {gpu}
        {scene}
        sources={[source]}
        at={t}
        active={enabled}
        {camera}
        onready={ready}
        {onerror}
        label={`${title}. Page Up and Page Down read traces. Space plays or pauses. Left and Right step samples.`}
      />
    {:else if !failed && recorded}
      <div class="c-empty"><p class="c-empty__text">Waiting for samples…</p></div>
    {/if}
  </div>
  <output class="lane__reading" aria-live={clock.state.status === 'playing' ? 'off' : 'polite'}>
    {#if exact && (focused || inspected !== undefined)}
      {String(sampleId)}: {exact.value === null ? 'No value' : String(exact.value)}{unit
        ? ` ${unit}`
        : ''} · {exact.at} s
    {/if}
  </output>
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
  .lane__count {
    margin-inline-start: auto;
    white-space: nowrap;
  }
  .lane__close {
    align-self: center;
  }
  .lane__surface {
    position: relative;
    flex: 1;
    min-block-size: 0;
  }
  .lane__reading {
    block-size: 1.5em;
    flex: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding-inline: var(--spacing-sm);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
