<!-- One plotted signal under a header naming it: frames append as they arrive, and hover seeks while
  paused. -->
<script lang="ts">
  import type { Gpu } from '@latkit/gpu'
  import { type Block, type Data, type Domain, itemId, type Query, read } from '@latkit/model'
  import { createMonitor, type Monitor } from '@latkit/monitor'
  import { onMount, untrack } from 'svelte'

  import { native, rowsOf } from '../../shared/cells.js'
  import type { Plot, ViewState } from '../../shared/messages.js'
  import { holdsPlot, plotName, samePlot } from '../../shared/plots.js'
  import { reader } from '../../shared/preferences.js'
  import { fieldName } from '../../shared/schema.js'
  import { clamp, type ClockState } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import type { Clock } from '../clock.js'
  import { nativeMenu } from '../menu.js'
  import { Recovery } from '../recovery.js'
  import type { Wants } from '../samples.js'
  import type { Theme } from '../theme.js'
  import CanvasHost from '../ui/CanvasHost.svelte'
  import Icon from '../ui/Icon.svelte'
  import {
    holds,
    plotConfig,
    plotOptions,
    plotRows,
    sameSelection,
    sameWindow,
    streamedValues,
    traceCount,
    traceSelection,
  } from './plot.js'

  /** How long a plot goes without a frame before the GPU is asked whether it still finishes work,
   *  and how long it then has to answer. */
  const STALL_MS = 10_000

  let {
    plot,
    view,
    source,
    sampled,
    covers,
    t,
    shown,
    theme,
    clock,
    tick,
    gpu,
    paused,
    generation,
    retries,
    ticks,
    streaming,
    stuck,
    onframe,
    onwants,
    onwindow,
  }: {
    plot: Plot
    view: ViewState
    /** The case with the frames read so far; a new snapshot each time frames arrive. */
    source: Data | undefined
    /** The fields, and their rows, whose samples `source` holds. */
    sampled: readonly Query.Selection[]
    /** Whether the samples held cover `window` of `from`'s `field`. */
    covers: (from: string, field: string, window: Domain) => boolean
    /** The playhead. */
    t: number
    /** The window every plot shows. */
    shown: Domain
    theme: Theme
    clock: Clock
    tick: ClockState
    /** The GPU the plots share. */
    gpu: () => Promise<Gpu>
    paused: boolean
    generation: number
    /** How many times the user asked the plots to try again: each starts over what it failed. */
    retries: number
    /** Whether its time ticks are labelled: the last of the plots, which share one time axis. */
    ticks: boolean
    /** Whether `source` brings the window a slice at a time, letting go of the slices drawn. */
    streaming: boolean
    /** Whether what the plots lack could not be read. */
    stuck: boolean
    onframe: () => void
    /** Where its drawing stands after each frame, so the slice it needs next is read; undefined
     *  once it draws no more. */
    onwants: (stands: Wants | undefined) => void
    /** The user panned or zoomed this plot to `bounds`. */
    onwindow: (bounds: Domain) => void
  } = $props()

  const id = $props.id()
  // What the plot reads of the state, each apart: a message that leaves one as it was changes
  // nothing that depends on it alone, as a selection leaves the plot's options.
  const schema = $derived(view.summary?.schema)
  const results = $derived(view.results)
  const mappings = $derived(view.bindings)
  const settings = $derived(reader(view.settings))
  const definition = $derived(schema?.types[plot.from]?.fields[plot.field])
  const unit = $derived(definition?.unit ? ` ${definition.unit}` : '')
  /** The type, the element when it plots one, and the field: "Bus 16 · Va". */
  const name = $derived(plotName(schema, plot))
  /** Whether the results on show hold the plotted field. */
  const recorded = $derived(holdsPlot(results, plot))
  /** Whether the samples on hand are the plot's: a plot just added waits for its own. */
  const streamed = $derived(holds(sampled, plot))
  const style = $derived(
    plotOptions(settings, theme.palette, theme.font, {
      ticks,
      ...(settings.get('monitor.yAxis.label') && { caption: fieldName(definition, plot.field) }),
    }),
  )
  /** The table the plot reads: samples arriving keep its index, and its rows. */
  const table = $derived(source?.tables[plot.from]?.index)
  /** What the results hold, which only grows once, as their header is read. */
  const held = $derived(`${results?.id}:${results?.outputs.length}`)
  /** The rows the plot draws: of its table and what the results hold, never of the samples, so
   *  frames arriving find them again for nothing. */
  const rows = $derived.by(() => {
    void table
    void held
    const { from, field, id } = plot
    return untrack(() =>
      source && table ? plotRows(source, results, { from, field, id }) : undefined,
    )
  })
  /** How many traces the plot draws, once its case's rows are held. */
  const traces = $derived(
    table && rows ? untrack(() => traceCount(source!, plot.from, rows)) : undefined,
  )

  let monitor = $state.raw<Monitor | null>(null)
  let lane = $state<HTMLElement>()
  let visible = $state(false)
  const resting = $derived(paused || !visible)
  let epoch = $state(0)
  let camera: Monitor['camera'] | undefined
  const recovery = new Recovery(
    () => {
      camera = monitor?.camera ?? camera
      epoch++
    },
    (error) =>
      bridge.report(error, {
        view: 'monitor',
        phase: 'draw',
        plot,
        results: view.results?.id,
        at: t,
      }),
  )
  // Asked to try again, a plot says a failure again should it recur.
  $effect.pre(() => {
    void retries
    untrack(() => recovery.reset())
  })
  let windowUpdate = 0
  let previousFit: boolean | undefined
  /** The plot's whole config, besides its canvas, time, and camera. */
  const config = $derived(
    source &&
      plotConfig(style, source, settings, plot, { bindings: mappings, results, rows, streaming }),
  )
  /** The values the streamed plot was last given to span. */
  let streamedFor: Domain | undefined
  /** A streamed plot never holds its whole window, so its values span the field's range as the
   *  results measured it while reading, rather than fit what it holds. */
  const values = () => (streaming ? streamedValues(results, plot, streamedFor) : undefined)

  /** Draw the plot on `canvas`; resolves to the teardown. */
  async function mount(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<() => void> {
    if (!config) throw new Error('Nothing to plot.')
    const device = await gpu()
    signal.throwIfAborted()
    const spanned = values()
    const made = createMonitor(device, {
      ...config,
      canvas,
      at: t,
      paused: resting,
      camera: {
        ...camera,
        x: [shown[0], shown[1]],
        ...(spanned
          ? { y: spanned, fit: false }
          : { fit: camera?.fit ?? settings.get('monitor.camera.fit') }),
      },
    })
    streamedFor = spanned
    let lastFrame = performance.now()
    let presentedAt: number | undefined
    const failed = (error: unknown) => {
      // The shared GPU owner replaces every plot together after device loss.
      if (!device.signal.aborted) recovery.fail(error)
    }
    const offs = [
      made.on('error', failed),
      made.on('frame', (frame) => {
        lastFrame = performance.now()
        presentedAt = frame.at
        canvas.dataset.rendered = 'true'
        recovery.presented()
        onframe()
        // Where its drawing stands matters only while the Monitor reads a slice at a time.
        if (streaming) onwants(made.stats().wants)
      }),
      made.on('select', (items) => {
        bridge.send({
          kind: 'select',
          element: items[0] ? { id: itemId(items[0]), field: plot.field } : null,
        })
      }),
      made.on('open', () => bridge.command('elementSource')),
      made.on('contextmenu', (event) =>
        nativeMenu(
          canvas,
          event.point,
          event.items.map((item) => ({ id: itemId(item), field: plot.field })),
          view,
          'monitor',
          plot,
        ),
      ),
      // A camera off the shared window was moved by the user.
      made.on('camera', (camera) => {
        if (!windowUpdate && !sameWindow(camera.x, shown)) onwindow([camera.x[0], camera.x[1]])
      }),
    ]
    // Hover seeks the clock at once; views coalesce their redraws into their own frame.
    const seek = (event: PointerEvent): void => {
      if (event.buttons !== 0 || event.pointerType === 'touch') return
      const { status, follow, span } = clock.state
      if (status !== 'paused' || follow) return
      const found = made.coordinateAt([event.offsetX, event.offsetY])
      if (found !== null && Number.isFinite(found)) clock.seek(clamp(found, span))
    }
    canvas.addEventListener('pointermove', seek)
    canvas.addEventListener('contextmenu', stop)
    monitor = made
    const inspected = canvas as HTMLCanvasElement & {
      gridkitPlot?: () => unknown
      gridkitPoint?: (at: number, value: number) => readonly number[] | null
      gridkitRead?: (point: [number, number]) => Promise<unknown>
    }
    inspected.gridkitPoint = (at, value) => {
      const table = made.config.source.tables[plot.from]!
      const reading = {
        source: made.config.source,
        index: table.index,
        row: 0,
        coordinate: at,
        value,
      }
      return made.locate(reading)
    }
    inspected.gridkitRead = async (point) =>
      (await made.pick(point)).map((item) => ({
        id: itemId(item),
        frame: item.frame,
        value: item.value,
      }))
    inspected.gridkitPlot = () => ({
      camera: made.camera,
      traces: made.config.traces,
      at: presentedAt,
      lastFrame,
      paused: made.config.paused,
      motion: made.config.motion,
      gpu: device.stats(),
      ...made.stats(),
    })
    // A renderer wedges when the GPU queue never finishes what it was given. A plot that is only slow
    // to prepare, as a large one is, has a queue that still drains, and draws however long that
    // takes; hidden lanes and idle plots need no frames at all.
    let probing = false
    let unmounted = false
    const health = setInterval(() => {
      if (resting || recovery.blocked) {
        lastFrame = performance.now()
        return
      }
      if (
        probing ||
        (presentedAt !== undefined && made.config.at === presentedAt) ||
        performance.now() - lastFrame <= STALL_MS
      )
        return
      probing = true
      const drained = device.device.queue.onSubmittedWorkDone().then(
        () => true,
        () => true,
      )
      const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STALL_MS))
      void Promise.race([drained, late]).then((alive) => {
        probing = false
        lastFrame = performance.now()
        // A stuck submission occupies the shared GPU's in-flight slots. Replacing only this
        // renderer would leave its replacement waiting on the same never-settling queue.
        if (!alive && !unmounted && !device.signal.aborted) {
          bridge.report(new Error('The GPU stopped finishing its work. Restarting graphics.'))
          device.destroy()
        }
      })
    }, 1000)
    return () => {
      unmounted = true
      // A plot drawn again starts its window over; one gone needs nothing.
      onwants(undefined)
      camera = made.camera
      clearInterval(health)
      delete inspected.gridkitPlot
      delete inspected.gridkitPoint
      delete inspected.gridkitRead
      canvas.removeEventListener('pointermove', seek)
      canvas.removeEventListener('contextmenu', stop)
      for (const off of offs) off()
      made.destroy()
      if (monitor === made) monitor = null
    }
  }
  /** Keeps the raw event from VS Code; the plot's own 'contextmenu' opens the menu for the picked
   *  trace. */
  const stop = (event: Event) => event.stopPropagation()

  // The plot keeps what did not change: new frames append, and equal options rebuild nothing.
  $effect(() => {
    if (monitor && config) monitor.set(config, { replace: true })
  })
  $effect(() => {
    const fit = settings.get('monitor.camera.fit')
    const spanned = values()
    // A streamed plot's values span its field's range; setting them turns fitting off.
    if (spanned) {
      if (monitor && !sameWindow(spanned, streamedFor)) monitor.set({ camera: { y: spanned } })
      streamedFor = monitor ? spanned : undefined
      return
    }
    // A recovered plot restores its camera, including a manually chosen value range.
    // Only a settings change, or the end of streaming, should replace that choice after mounting.
    if (fit !== previousFit || streamedFor) monitor?.set({ camera: { fit } })
    previousFit = fit
    streamedFor = undefined
  })
  $effect(() => {
    if (monitor && !sameWindow(monitor.camera.x, shown)) {
      // Camera events arrive in a microtask. A programmatic update is not a user's pan.
      windowUpdate++
      monitor.set({ camera: { x: [shown[0], shown[1]] } }, { animate: false })
      queueMicrotask(() => windowUpdate--)
    }
  })
  const selected = $derived(view.selection?.id)
  // Highlight the selected element's trace when it is of the plotted type. The plot hears only of
  // another trace: each selection it is given draws the highlighted trace again.
  $effect(() => {
    void source // Each new snapshot needs the row found again.
    if (!monitor) return
    const next = traceSelection(monitor.config.source, selected, plot.from, rows)
    if (!sameSelection(next, monitor.selection)) monitor.select(next)
  })
  $effect(() => {
    if (!monitor) return
    // Do not subscribe offscreen plots to every clock tick; resume at the current playhead.
    if (resting) monitor.set({ paused: true })
    else monitor.set({ paused: false, at: t })
  })

  /** Whether the plot has focus; while it does, a screen reader hears one trace at the playhead. */
  let inspecting = $state(false)
  /** The row offset of the trace read. */
  let trace = $state(0)
  let sample = $state.raw<{ label: string; value: number | null; t: number } | null>(null)

  // Read the inspected trace at the playhead while focused and the clock is still.
  $effect(() => {
    if (!inspecting || !recorded || tick.status === 'playing' || tick.follow) return
    const at = t
    const snapshot = source
    const selection = rows
    if (!snapshot) {
      sample = null
      return
    }
    // Samples the plot does not hold, as while a long window streams, are read from the results.
    const held = covers(plot.from, plot.field, [at, at])
    const { from, field, id } = plot
    const offset = id ? 0 : trace
    const reading = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        const query = {
          kind: 'rows' as const,
          from,
          select: [field],
          ids: true,
          offset,
          limit: 1,
          at,
          rows: selection,
        }
        if (!held) {
          const results = view.results?.id
          return results ? bridge.request('query', { results, query }, reading.signal) : []
        }
        const blocks: Block.Rows[] = []
        for await (const block of read(snapshot, query, { signal: reading.signal }))
          if (block.kind === 'rows') blocks.push(block)
        return blocks
      })().then(
        (blocks) => {
          if (reading.signal.aborted || source !== snapshot) return
          const row = rowsOf(blocks)[0]
          const value = row?.values[field]
          sample = row?.id
            ? {
                label: native(row.id),
                value: typeof value === 'number' ? value : null,
                t: at,
              }
            : null
        },
        (error) => {
          if (!reading.signal.aborted) {
            sample = null
            bridge.report(error)
          }
        },
      )
    }, 150)
    return () => {
      clearTimeout(timer)
      reading.abort()
    }
  })

  /** The plot's keys; any other key is left to VS Code. */
  const keys: Readonly<Record<string, () => void>> = {
    PageUp: () => (trace = Math.max(0, trace - 1)),
    PageDown: () => (trace = Math.min(Math.max(0, (traces ?? 1) - 1), trace + 1)),
    ' ': () => clock.act({ action: 'playPause' }),
    ArrowLeft: () => clock.act({ action: 'step', value: -1 }),
    ArrowRight: () => clock.act({ action: 'step', value: 1 }),
  }

  function key(event: KeyboardEvent): void {
    if (!settings.get('monitor.input.keyboard') || tick.status === 'idle') return
    const act = keys[event.key]
    if (act === undefined) return
    event.preventDefault()
    act()
  }

  onMount(() =>
    bridge.on((incoming) => {
      if (incoming.kind !== 'action' || incoming.command !== 'signalRange') return
      const { plot: target, range } = incoming.value as { plot?: Plot; range?: [number, number] }
      if (
        target &&
        samePlot(target, plot) &&
        range?.length === 2 &&
        range.every(Number.isFinite) &&
        range[0] < range[1]
      )
        // Setting y turns fitting off.
        monitor?.set({ camera: { y: range } })
    }),
  )
  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting && entry.intersectionRatio > 0
    })
    if (lane) observer.observe(lane)
    return () => {
      observer.disconnect()
      recovery.dispose()
    }
  })
</script>

<section class="lane" aria-labelledby={`${id}-name`} bind:this={lane}>
  <header class="lane__head">
    <h2 class="lane__name" id={`${id}-name`} title={name}>{name}</h2>
    {#if traces !== undefined}
      <span class="lane__count">{traces.toLocaleString()} {traces === 1 ? 'trace' : 'traces'}</span>
    {/if}
    <button
      type="button"
      class="c-icon-btn lane__close"
      title="Remove plot"
      aria-label={`Remove ${name}`}
      onclick={() =>
        bridge.command('removePlot', {
          uri: view.summary?.uri,
          version: view.summary?.version,
          origin: 'monitor',
          plot,
        })}
    >
      <Icon name="close" />
    </button>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions (The canvas inside takes focus; its keys bubble here.) -->
  <div
    class="lane__surface"
    aria-describedby={`${id}-keys`}
    onkeydown={key}
    onfocusin={() => (inspecting = true)}
    onfocusout={() => (inspecting = false)}
  >
    {#if recorded && source && view.results?.frames && streamed}
      {#key `${generation}:${epoch}`}
        <CanvasHost
          {mount}
          onerror={(error) => recovery.fail(error)}
          label={`${name}. Right-click a trace for actions.`}
        />
      {/key}
    {:else}
      <div class="c-empty lane__empty">
        <!-- Samples that could not be read were said once, in a notification: the plot stops
          saying it waits for them. -->
        {#if !stuck && (view.results?.growing || (recorded && view.results?.frames))}
          <p class="c-empty__text">Waiting for samples…</p>
        {/if}
      </div>
    {/if}
  </div>
  <span class="c-sr-only" id={`${id}-keys`}>
    Page Up and Page Down read traces. Space plays or pauses, and Left and Right step through
    samples. Move the pointer over the paused plot to seek.
  </span>
  <span
    class="c-sr-only"
    role="status"
    aria-live={tick.status === 'playing' || tick.follow ? 'off' : 'polite'}
  >
    {#if inspecting && sample}
      {sample.label}, {sample.value === null ? 'no value' : sample.value.toPrecision(6)}{unit}, {sample.t.toFixed(
        3,
      )}
      {schema?.axis?.unit ?? ''}.
    {/if}
  </span>
</section>

<style>
  /* The plots share the Monitor's height alike, down to a size they stay readable at. */
  .lane {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 7rem;
    background: var(--color-surface-1);
  }

  /* The signal's name, with its unit, and how many traces it draws, in a line above the plot. */
  .lane__head {
    display: flex;
    gap: var(--spacing-xs);
    align-items: baseline;
    min-inline-size: 0;
    padding-block: var(--spacing-2xs) 0;
    padding-inline: var(--spacing-sm) var(--spacing-2xs);
    color: var(--color-text-2);
    font-size: var(--text-sm);
    line-height: 1.5rem;
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
    flex: none;
    margin-inline-start: auto;
    font-variant-numeric: tabular-nums;
  }

  /* Shown while the pointer or focus is on the lane. */
  .lane__close {
    flex: none;
    align-self: center;
    min-width: 1.5rem;
    min-height: 1.5rem;
    opacity: 0;
  }

  .lane:hover .lane__close,
  .lane:focus-within .lane__close {
    opacity: 1;
  }

  .lane__surface {
    position: relative;
    flex: 1;
    min-block-size: 0;
  }

  .lane__empty {
    block-size: 100%;
  }
</style>
