<script lang="ts">
  import type { VideoProgress, VideoWrite } from '@latkit/video'
  import { onMount } from 'svelte'

  import type { Results, VideoView, ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import { CanvasGpu } from '../gpu.js'
  import { plotStatics, rowsOnce, staticNeeds } from '../rows.js'
  import { networkNeeds, plotBudget, plotNeeds, Samples, type Wants } from '../samples.js'
  import { appearance } from '../theme.js'
  import Section from '../ui/Section.svelte'
  import Select from '../ui/Select.svelte'
  import Switch from '../ui/Switch.svelte'
  import {
    DEFAULTS,
    exportable,
    exportVideo,
    prefetchMap,
    type VideoSettings,
    viewsOf,
  } from './video.js'

  const ENDS = [0, 1] as const

  let view = $state.raw<ViewState>({})
  /** The settings the user chose, kept when the webview reloads. */
  let settings = $state.raw<VideoSettings>({
    ...DEFAULTS,
    ...bridge.state<{ settings?: Partial<VideoSettings> }>({}).settings,
  })
  $effect(() => bridge.save({ settings }))
  let progress = $state.raw<VideoProgress | null>(null)
  let status = $state<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  /** Where the last video was written. */
  let saved = $state('')
  /** The results the time range came from, and whether the user has edited it since. */
  let seeded: string | undefined
  let touched = false
  /** The samples the Monitor's part plots, all of the time range; and those the Network's part
   *  maps, a moment at a time, read a few chunks ahead of the frame drawn. */
  const plotting = new Samples(bridge, () => {}, plotBudget)
  const mapping = new Samples(bridge, () => {})
  let stop: AbortController | undefined
  /** Whether the user cancelled the running export. */
  let cancelled = false
  /** The moments the Network's part of the last export was given the samples of, and the slices
   *  its Monitor's part streamed, for tests. */
  let moments: number[] = []
  let slices = 0
  ;(window as { gridkitExport?: () => unknown }).gridkitExport = () => ({ moments, slices })
  const owner = new CanvasGpu()
  const id = $props.id()

  const busy = $derived(status === 'running')
  const range = $derived(view.results?.domain)
  const views = $derived(viewsOf(view))
  const ready = $derived(exportable(settings, view))
  const percent = $derived(
    progress ? Math.floor((100 * progress.completedFrames) / Math.max(1, progress.totalFrames)) : 0,
  )
  const duration = $derived((settings.timeRange[1] - settings.timeRange[0]) / settings.rate)

  const change = (next: Partial<VideoSettings>) => (settings = { ...settings, ...next })

  function toggle(shown: VideoView, on: boolean): void {
    change({
      views: on ? [...settings.views, shown] : settings.views.filter((item) => item !== shown),
    })
  }

  /** Set one end of the time range. */
  function bound(end: 0 | 1, value: number): void {
    touched = true
    change({
      timeRange: end === 0 ? [value, settings.timeRange[1]] : [settings.timeRange[0], value],
    })
  }

  function useRecordedRange(): void {
    touched = false
    if (range) change({ timeRange: [range[0], range[1]] })
  }

  /** Export to a file the user picks, written as frames are encoded. */
  async function start(): Promise<void> {
    const chosen = settings
    const shown = view
    const { summary, uri } = shown
    if (busy || !ready || !summary || !uri) return
    const control = (stop = new AbortController())
    const { signal } = control
    /** Aborted once the export ends, however it ends. */
    const done = new AbortController()
    status = 'running'
    cancelled = false
    progress = null
    moments = []
    slices = 0
    bridge.send({ kind: 'busy', busy: true })
    let file: number | null = null
    /** The results the export draws, held for it: whatever shows meanwhile, they stay till it ends. */
    let results: Results | undefined
    try {
      results =
        shown.results && (await bridge.request('share', { results: shown.results.id }, signal))
      const state: ViewState = { ...shown, ...(results && { results }) }
      const name = summary.name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')
      file = await bridge.request(
        'videoOpen',
        { uri, name: `${name}.${chosen.format}`, format: chosen.format },
        signal,
      )
      if (file === null) {
        status = 'idle'
        return
      }
      const cameras = await bridge.request('cameras', { uri }, signal)
      // The case the results were read against, which the summary then describes: what its views
      // draw of it, or, for the Monitor's part alone, the rows its plots draw.
      const of = { summary, ...(results?.frames && { results: results.id }) }
      const held = await rowsOnce(
        bridge,
        of,
        chosen.views.some((each) => each !== 'monitor')
          ? staticNeeds(summary, state.bindings, false)
          : plotStatics(summary, state.plots ?? []),
        chosen.views.includes('diagram'),
        signal,
      )
      const rows = held.data
      // The Monitor's part plots the whole time range, so every sample of it comes first; a range
      // holding more than a page keeps streams through the plots a slice at a time instead.
      const plotted = chosen.views.includes('monitor') ? plotNeeds(state) : []
      const first = plotting.plot(results, plotted, chosen.timeRange, 'start')
      if (first) slices++
      await plotting.until(first ?? chosen.timeRange, signal)
      const stream =
        first === undefined
          ? undefined
          : async (wants: Wants) => {
              const next = plotting.plot(results, plotted, chosen.timeRange, wants)
              if (!next) return undefined
              slices++
              await plotting.until(next, signal)
              return plotting.data(rows)
            }
      // A field the plots read whole over the range is held already, and mapped from what they hold
      // rather than read again; one they read a slice at a time is read for each moment.
      const whole = first === undefined
      const mapped = (chosen.views.includes('network') ? networkNeeds(state) : []).filter(
        ({ selection }) => !whole || !plotting.has(selection),
      )
      const gpu = await owner.get()
      signal.throwIfAborted()
      // Each export follows the device it draws on, which an earlier export may have created; the
      // export's end lets go of it.
      const lost = () => control.abort(new Error('WebGPU device lost.'))
      if (gpu.signal.aborted) lost()
      gpu.signal.addEventListener('abort', lost, { once: true, signal: done.signal })
      const handle = file
      const output = new WritableStream<VideoWrite>({
        write: ({ position, bytes }) =>
          bridge.request('videoWrite', { file: handle, position, bytes }),
      })
      await exportVideo(
        gpu,
        chosen,
        {
          state,
          rows,
          plotted: plotting.data(rows),
          ...(stream && { stream }),
          mapped: async (at, s) => {
            mapping.want(results, mapped, [at, at], { at, travel: 1 })
            await mapping.until([at, at], s)
            moments.push(at)
            return mapping.data(whole ? plotting.data(rows) : rows)
          },
          presentation: held.presentation ?? {},
          cameras,
        },
        output,
        signal,
        (made) => (progress = made),
      )
      saved = (await bridge.request('videoClose', { file })) ?? ''
      file = null
      status = 'done'
    } catch (reason) {
      status = cancelled ? 'cancelled' : 'idle'
      // Report why the export was aborted, not the abort error it caused.
      if (!cancelled)
        bridge.report(signal.aborted && signal.reason instanceof Error ? signal.reason : reason)
    } finally {
      done.abort()
      // The samples served this export alone.
      plotting.clear()
      mapping.clear()
      if (file !== null) await bridge.request('videoClose', { file, abort: true }).catch(() => {})
      if (results) await bridge.request('unshare', { results: results.id }).catch(() => {})
      bridge.send({ kind: 'busy', busy: false })
    }
  }

  onMount(() => {
    const stops = [
      bridge.on((message) => {
        if (message.kind !== 'state') return
        view = merged(view, message.state)
        appearance(view.settings)
        prefetchMap(view)
        const { results } = view
        // The time range follows the results until the user edits it.
        if (
          results &&
          results.domain[1] > results.domain[0] &&
          (results.id !== seeded || !touched) &&
          !busy
        ) {
          if (results.id !== seeded) touched = false
          seeded = results.id
          const [start, end] = settings.timeRange
          if (start !== results.domain[0] || end !== results.domain[1])
            change({ timeRange: [results.domain[0], results.domain[1]] })
        }
        const offered = viewsOf(view).map(({ value }) => value)
        if (view.summary && settings.views.some((shown) => !offered.includes(shown)))
          change({ views: settings.views.filter((shown) => offered.includes(shown)) })
      }),
    ]
    bridge.ready()
    return () => {
      stop?.abort()
      for (const off of stops) off()
      owner.dispose()
    }
  })
</script>

<!-- With no case open there is nothing to export. -->
{#if view.uri}
  <form
    class="export c-settings"
    data-testid="video-export"
    onsubmit={(event) => {
      event.preventDefault()
      void start()
    }}
  >
    <fieldset disabled={busy} class="export__fields">
      <Section label="Views">
        {#each views as shown (shown.value)}
          <Switch
            label={shown.label}
            bind:checked={
              () => settings.views.includes(shown.value), (on) => toggle(shown.value, on)
            }
          />
        {/each}
        <Select
          label="Arrangement"
          disabled={settings.views.length < 2}
          options={[
            { value: 'column', label: 'Stacked' },
            { value: 'row', label: 'Side by side' },
          ]}
          bind:value={
            () => settings.layout,
            (layout) => {
              if (layout) change({ layout })
            }
          }
        />
      </Section>
      <Section label="Time">
        {#each ENDS as end (end)}
          <div class="c-row c-setting-row">
            <label class="c-row__label" for="{id}-{end}">{end ? 'End' : 'Start'} (s)</label>
            <input
              id="{id}-{end}"
              class="c-input"
              type="number"
              step="any"
              min={range?.[0]}
              max={range?.[1]}
              value={settings.timeRange[end]}
              oninput={(event) => bound(end, event.currentTarget.valueAsNumber)}
            />
          </div>
        {/each}
        <button
          type="button"
          class="c-btn c-btn--sm export__range"
          disabled={!range}
          onclick={useRecordedRange}
        >
          Use recorded range
        </button>
        <Select
          label="Playback speed"
          options={[0.25, 0.5, 1, 2, 4].map((value) => ({ value, label: value + 'x' }))}
          bind:value={
            () => settings.rate,
            (rate) => {
              if (rate) change({ rate })
            }
          }
        />
        {#if Number.isFinite(duration) && duration > 0}
          <p class="c-note">Output duration: {duration.toFixed(2)} s.</p>
        {/if}
      </Section>
      <Section label="Output">
        <Select
          label="Format"
          options={[
            { value: 'mp4', label: 'MP4' },
            { value: 'webm', label: 'WebM' },
          ]}
          data-testid="video-format"
          bind:value={
            () => settings.format,
            (format) => {
              if (format) change({ format })
            }
          }
        />
        <Select
          label="Resolution"
          options={[
            { value: 720, label: '720p' },
            { value: 1080, label: '1080p' },
            { value: 2160, label: '4K' },
          ]}
          data-testid="video-resolution"
          bind:value={
            () => settings.height,
            (height) => {
              if (height) change({ height, width: (height * 16) / 9 })
            }
          }
        />
        <Select
          label="Frame rate"
          options={[24, 30, 60].map((value) => ({ value, label: value + ' fps' }))}
          bind:value={
            () => settings.frameRate,
            (frameRate) => {
              if (frameRate) change({ frameRate })
            }
          }
        />
        <Select
          label="Quality"
          options={[
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'very-high', label: 'Very high' },
          ]}
          bind:value={
            () => settings.quality,
            (quality) => {
              if (quality) change({ quality })
            }
          }
        />
      </Section>
    </fieldset>
    <div class="export__footer">
      <div class="export__actions">
        <button
          class="c-btn c-btn--primary"
          type="submit"
          disabled={busy || !ready}
          data-testid="video-start"
        >
          Export video
        </button>
        {#if busy}
          <button
            class="c-btn"
            type="button"
            onclick={() => {
              cancelled = true
              stop?.abort()
            }}
          >
            Cancel
          </button>
        {/if}
      </div>
      <div class="export__status">
        {#if busy}
          <progress max="100" value={percent} aria-label="Video export progress"></progress>
          <p class="c-note" role="status">
            {progress?.phase === 'finalizing'
              ? 'Finalizing video...'
              : progress
                ? 'Exporting video: ' + percent + '%'
                : 'Preparing video...'}
          </p>
        {:else if status === 'done'}
          <p class="c-note" role="status" data-testid="video-done">Exported {saved}</p>
        {:else if status === 'cancelled'}
          <p class="c-note" role="status">Export cancelled.</p>
        {/if}
      </div>
    </div>
  </form>
{/if}

<style>
  .export {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    overflow-y: auto;
  }

  .export__fields {
    min-inline-size: 0;
  }

  .export :global(.c-input) {
    inline-size: 8rem;
    max-inline-size: 100%;
  }

  .export__fields:disabled {
    opacity: 0.7;
  }

  .export__range {
    margin-inline-start: var(--spacing-xs);
  }

  .export__footer {
    margin-block-start: auto;
    padding: var(--spacing-md) var(--spacing-sm);
    border-block-start: 1px solid var(--color-border);
  }

  .export__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
  }

  .export__status {
    min-block-size: 4rem;
    padding-block-start: var(--spacing-sm);
    overflow-wrap: anywhere;
  }

  .export__status .c-note {
    margin-inline: 0;
  }

  progress {
    inline-size: 100%;
    block-size: 0.4rem;
    accent-color: var(--color-primary-text);
  }
</style>
