<!-- One plotted signal: frames append as they arrive, and hover seeks while paused. -->
<script lang="ts">
  import type { Gpu } from '@latkit/gpu'
  import { type Data, type Domain, type FieldSelection, itemId } from '@latkit/model'
  import { createMonitor, type Monitor } from '@latkit/monitor'
  import { onMount } from 'svelte'

  import { recordedRows } from '../../shared/bindings.js'
  import { rowsOf } from '../../shared/cells.js'
  import type { Plot, ViewState } from '../../shared/messages.js'
  import { reader } from '../../shared/preferences.js'
  import { fieldName, typeName } from '../../shared/schema.js'
  import { clamp, type ClockState } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import type { Clock } from '../clock.js'
  import { nativeMenu } from '../menu.js'
  import type { Palette } from '../theme.js'
  import CanvasHost from '../ui/CanvasHost.svelte'
  import Icon from '../ui/Icon.svelte'
  import {
    axisLabel,
    holds,
    PLOT_LIMITS,
    plotOptions,
    sameWindow,
    traceSelection,
    tracesOf,
  } from './plot.js'

  let {
    plot,
    view,
    source,
    sampled,
    t,
    shown,
    theme,
    clock,
    tick,
    gpu,
    paused,
    onwindow,
  }: {
    plot: Plot
    view: ViewState
    /** The case with the run's frames so far; a new snapshot each time frames arrive. */
    source: Data | undefined
    /** The fields, and their rows, whose samples `source` holds. */
    sampled: readonly FieldSelection[]
    /** The playhead. */
    t: number
    /** The window every plot shows. */
    shown: Domain
    theme: { readonly palette: Palette; readonly font: string }
    clock: Clock
    tick: ClockState
    /** The GPU the plots share. */
    gpu: () => Promise<Gpu>
    paused: boolean
    /** The user panned or zoomed this plot to `bounds`. */
    onwindow: (bounds: Domain) => void
  } = $props()

  const id = $props.id()
  const schema = $derived(view.summary?.schema)
  const definition = $derived(schema?.types[plot.from]?.fields[plot.field])
  const unit = $derived(definition?.unit ? ` ${definition.unit}` : '')
  const name = $derived(
    schema === undefined
      ? plot.field
      : `${typeName(schema, plot.from)} · ${fieldName(definition, plot.field)}` +
          (plot.id ? ` · ${plot.id.slice(plot.from.length + 1)}` : ''),
  )
  /** Whether the run on show recorded the plotted field. */
  const recorded = $derived(
    view.run?.outputs.some(
      (output) => output.from === plot.from && output.select.includes(plot.field),
    ) ?? false,
  )
  /** Whether the samples on hand are the plot's: a plot just added waits for its own. */
  const streamed = $derived(
    holds(sampled, { type: plot.from, field: plot.field, ...(plot.id && { id: plot.id }) }),
  )
  const settings = $derived(reader(view.settings))
  /** The name runs up the value axis, beside its ticks, over the height the plot draws in: under
   *  the top padding, and above the time axis's ticks and caption. */
  const axis = $derived({
    shown: settings.get('monitor.yAxis.visible'),
    below: settings.get('monitor.xAxis.visible') ? 3 * settings.get('monitor.fontSizePx') : 0,
  })
  const style = $derived(
    plotOptions(
      settings,
      theme.palette,
      theme.font,
      axisLabel(schema?.axis),
      fieldName(definition, plot.field),
    ),
  )
  const rows = $derived(
    plot.id
      ? { kind: 'ids' as const, ids: [plot.id] }
      : recordedRows(view.run?.outputs ?? [], { type: plot.from, field: plot.field }),
  )
  const traces = $derived(
    tracesOf(
      settings,
      { type: plot.from, field: plot.field, ...(plot.id && { id: plot.id }) },
      view.bindings,
      rows,
      view.run,
    ),
  )

  let monitor = $state.raw<Monitor | null>(null)
  let windowUpdate = 0
  /** The plot's whole config, besides its canvas, time, and camera. */
  const config = $derived(source && { ...style, source, traces, limits: PLOT_LIMITS })

  /** Draw the plot on `canvas`; resolves to the teardown. */
  async function mount(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<() => void> {
    if (!config) throw new Error('Nothing to plot.')
    const device = await gpu()
    signal.throwIfAborted()
    const made = createMonitor(device, {
      canvas,
      at: t,
      source: config.source,
      traces: config.traces,
      limits: PLOT_LIMITS,
      camera: { x: [shown[0], shown[1]], fit: settings.get('monitor.camera.fit') },
    })
    made.set(config, { replace: true })
    const offs = [
      made.on('error', (error) => bridge.report(error)),
      made.on('frame', () => {
        canvas.dataset.rendered = 'true'
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
    const inspected = canvas as HTMLCanvasElement & { gridkitPlot?: () => unknown }
    inspected.gridkitPlot = () => ({
      camera: made.camera,
      traces: made.config.traces,
      ...made.stats(),
    })
    return () => {
      delete inspected.gridkitPlot
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
    monitor?.set({ camera: { fit: settings.get('monitor.camera.fit') } })
  })
  $effect(() => {
    if (monitor && !sameWindow(monitor.camera.x, shown)) {
      // Camera events arrive in a microtask. A programmatic update is not a user's pan.
      windowUpdate++
      monitor.set({ camera: { x: [shown[0], shown[1]] } }, { animate: false })
      queueMicrotask(() => windowUpdate--)
    }
  })
  // Highlight the selected element's trace when it is of the plotted type.
  $effect(() => {
    const selected = view.selection?.id
    void source // Each new snapshot needs the row found again.
    if (!monitor) return
    monitor.select(traceSelection(monitor.config.source, selected, plot.from, rows))
  })
  $effect(() => {
    monitor?.set({ at: t })
  })
  $effect(() => {
    monitor?.set({ paused })
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
    const { from, field, id } = plot
    const offset = id ? 0 : trace
    const reading = new AbortController()
    const timer = setTimeout(() => {
      bridge
        .request(
          'query',
          {
            kind: 'rows',
            from,
            select: [field],
            ids: true,
            offset,
            limit: 1,
            at,
            ...(id && { rows: { kind: 'ids', ids: [id] } }),
          },
          reading.signal,
        )
        .then(
          (blocks) => {
            const row = rowsOf(blocks)[0]
            const value = row?.values[field]
            sample = row?.id
              ? {
                  label: row.id.slice(from.length + 1),
                  value: typeof value === 'number' ? value : null,
                  t: at,
                }
              : null
          },
          () => (sample = null),
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
    PageDown: () => (trace = trace + 1),
    ' ': () => clock.act({ action: 'playPause' }),
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
        target?.from === plot.from &&
        target.field === plot.field &&
        target.id === plot.id &&
        range?.length === 2 &&
        range.every(Number.isFinite) &&
        range[0] < range[1]
      )
        // Setting y turns fitting off.
        monitor?.set({ camera: { y: range } })
    }),
  )
</script>

<section class="lane" aria-labelledby={`${id}-name`}>
  <h2 class="lane__name" id={`${id}-name`} title={name} style:inset-block-end={axis.below + 'px'}>
    {name}
  </h2>
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
  <!-- svelte-ignore a11y_no_static_element_interactions (The canvas inside takes focus; its keys bubble here.) -->
  <div
    class="lane__surface"
    class:lane__surface--bare={!axis.shown}
    aria-describedby={`${id}-keys`}
    onkeydown={key}
    onfocusin={() => (inspecting = true)}
    onfocusout={() => (inspecting = false)}
  >
    {#if recorded && source && view.run?.frames && streamed}
      <CanvasHost {mount} label={`${name}. Right-click a trace for actions.`} />
    {:else}
      <div class="c-empty lane__empty">
        <p class="c-empty__text">
          {view.run?.state === 'running' || (recorded && view.run?.frames)
            ? 'Waiting for samples…'
            : view.run
              ? `This simulation did not record ${name}.`
              : `Start a simulation to plot ${name}.`}
        </p>
      </div>
    {/if}
  </div>
  <span class="c-sr-only" id={`${id}-keys`}>
    Page Up and Page Down read traces. Space plays or pauses. Move the pointer over the paused plot
    to seek.
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
  .lane {
    position: relative;
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    min-block-size: 10rem;
    background: var(--color-surface-1);
  }

  /* The signal's name reads up the value axis at the lane's left edge, in the gutter the plot
     leaves for its ticks. */
  .lane__name {
    position: absolute;
    z-index: 1;
    inset-block-start: var(--spacing-sm);
    inset-inline-start: var(--spacing-2xs);
    overflow: hidden;
    color: var(--color-text-2);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    white-space: nowrap;
    text-overflow: ellipsis;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
  }

  /* Shown while the pointer or focus is on the lane, over the plot's top right corner. */
  .lane__close {
    position: absolute;
    z-index: 1;
    inset-block-start: var(--spacing-2xs);
    inset-inline-end: var(--spacing-2xs);
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

  /* Without a value axis there is no gutter, so the name takes a column of its own. */
  .lane__surface--bare {
    padding-inline-start: calc(var(--text-sm) * 1.2 + var(--spacing-xs));
  }

  .lane__empty {
    block-size: 100%;
  }
</style>
