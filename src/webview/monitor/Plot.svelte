<script lang="ts">
  import type { Data, Gpu, Id, View } from 'latkit'
  import { onMount, untrack } from 'svelte'

  import type { ExactSample, FrameRequest, TimeRange } from '../../shared/data.js'
  import { fieldDefinition } from '../../shared/document.js'
  import { type Plot as Plotted, type ViewState } from '../../shared/messages.js'
  import { holdsPlot, plotName } from '../../shared/plots.js'
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
  import { plotCamera, plotRequest, sameWindow, SETTLE_MS } from './plot.js'

  let {
    plot,
    app,
    gpu,
    reads,
    active,
    shown,
    settling,
    t,
    clock,
    themeVersion,
    register,
    onwindow,
    onerror,
  }: {
    plot: Plotted
    app: ViewState
    gpu: Gpu
    reads: FrameReads
    active: boolean
    shown: TimeRange
    /** Whether a zoom or pan is under way, whose samples the plot reads once it settles. */
    settling: boolean
    t: number
    clock: Clock
    themeVersion: number
    register: (view: View) => () => void
    onwindow: (range: TimeRange) => void
    onerror: (error: unknown) => void
  } = $props()
  const frames = new FrameWindow(untrack(() => reads))
  let source = $state.raw<Data>()
  let native = $state.raw<View>()
  /** The device pixel columns the lane spans, which latkit draws its traces across: none until the
   *  lane is laid out. */
  let columns = $state(0)
  let visible = $state(true)
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
    return source ? plotScene(source, plot, settings, nativeTheme(settings, 'monitor')) : undefined
  })
  const framed = $derived(plotCamera(plot, shown))
  const sampleId = $derived(inspected ?? plot.id ?? ids[Math.min(trace, ids.length - 1)])
  const unit = $derived(
    app.summary ? fieldDefinition(app.summary.definition, plot.from, plot.field)?.unit : undefined,
  )
  /** The trace read at the playhead while the plot holds focus or the pointer. */
  const reading = $derived.by(() => {
    if (!exact || (!focused && inspected === undefined)) return ''
    const value = exact.value === null ? 'No value' : String(exact.value)
    return `${String(sampleId)}: ${value}${unit ? ` ${unit}` : ''} · ${exact.at} s`
  })

  function observe(element: HTMLElement) {
    let resized: ReturnType<typeof setTimeout> | undefined
    const size = new ResizeObserver(([entry]) => {
      const box = entry?.devicePixelContentBoxSize[0]
      if (!box) return
      const next = Math.max(1, box.inlineSize)
      clearTimeout(resized)
      // The lane's first width reads at once; a resize, once it settles.
      if (!columns) columns = next
      else resized = setTimeout(() => (columns = next), SETTLE_MS)
    })
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry) visible = entry.isIntersecting
    })
    size.observe(element, { box: 'device-pixel-content-box' })
    intersection.observe(element)
    return () => {
      clearTimeout(resized)
      size.disconnect()
      intersection.disconnect()
    }
  }

  /** The read under way of the window the plot shows. One runs at a time, each once the view has
   *  drawn what it holds and of every frame recorded by then, so a run that records faster than
   *  this page draws is plotted as often as the page can draw it. */
  let fetching: { key: string; controller: AbortController; again: boolean } | undefined
  function read(request: FrameRequest) {
    const key = JSON.stringify(request)
    if (fetching?.key === key) {
      fetching.again = true
      return
    }
    fetching?.controller.abort()
    const current = (fetching = { key, controller: new AbortController(), again: false })
    const { signal } = current.controller
    failed = false
    void (async () => {
      do {
        current.again = false
        // A view gone meanwhile has nothing left to draw.
        await untrack(() => native)
          ?.done({ signal })
          .catch(() => signal.throwIfAborted())
        const version = results?.frames
        if (!version) return
        if ((await frames.receive(request, version, signal)) && !signal.aborted)
          source = frames.data
      } while (current.again)
    })().then(
      () => {
        if (fetching === current) fetching = undefined
      },
      (error: unknown) => {
        if (fetching === current) fetching = undefined
        if (!signal.aborted) {
          failed = true
          onerror(error)
        }
      },
    )
  }
  function stop() {
    fetching?.controller.abort()
    fetching = undefined
  }
  $effect(() => {
    if (enabled && !settling && columns && results?.frames && recorded)
      read(plotRequest(results, plot, shown, columns))
    else stop()
  })
  $effect(() => {
    if (native) native.camera = framed
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
      if (plot.range) bridge.send({ kind: 'range', plot, range: null })
      onwindow(results.domain)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  onMount(() => () => {
    stop()
    frames.clear()
  })
</script>

<section class="lane" aria-label={title} {@attach observe}>
  <header class="lane__head">
    <h2 class="lane__name">{title}</h2>
    <output class="lane__reading" aria-live={clock.state.status === 'playing' ? 'off' : 'polite'}>
      {reading}
    </output>
    <button
      class="c-icon-btn lane__close"
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
        camera={framed}
        onready={ready}
        {onerror}
        label={`${title}. Page Up and Page Down read traces. Space plays or pauses. Left and Right step samples.`}
      />
    {:else if !failed && recorded}
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
