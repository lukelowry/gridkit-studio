<!-- Configure and export video using separate renderers so the workbench stays usable. -->
<script lang="ts">
  import type { Data, FieldValues } from '@latkit/model'
  import type { VideoProgress, VideoWrite } from '@latkit/video'
  import { onMount } from 'svelte'

  import type { VideoView, ViewState } from '../../messages.js'
  import { bridge, merged } from '../bridge.js'
  import { CanvasGpu } from '../gpu.js'
  import { receive } from '../stream.js'
  import { appearance } from '../theme.js'
  import Section from '../ui/Section.svelte'
  import Select from '../ui/Select.svelte'
  import Switch from '../ui/Switch.svelte'
  import {
    blockedReason,
    DEFAULTS,
    exportVideo,
    plotsOf,
    type VideoSettings,
    viewsOf,
  } from './video.js'

  let view = $state.raw<ViewState>({})
  let settings = $state.raw<VideoSettings>(DEFAULTS)
  let progress = $state.raw<VideoProgress | null>(null)
  let status = $state<'idle' | 'running' | 'done' | 'cancelled' | 'failed'>('idle')
  let error = $state<string | null>(null)
  /** Where the last video was written. */
  let saved = $state('')
  /** The run the times were taken from, and whether the reader has set them since. */
  let seeded: string | undefined
  let touched = false
  /** The case the extension streamed for the export under way, and where its elements stand. */
  let rows: Data | undefined
  let samples: Data | undefined
  let placement: Record<string, FieldValues> = {}
  let presentation: Record<string, FieldValues> = {}
  let stop: AbortController | undefined
  /** Whether the reader gave the export under way up. */
  let cancelled = false
  const owner = new CanvasGpu()
  const id = $props.id()

  const busy = $derived(status === 'running')
  const range = $derived(view.run?.domain)
  const views = $derived(viewsOf(view))
  const blocked = $derived(blockedReason(settings, view))
  const percent = $derived(
    progress ? Math.floor((100 * progress.completedFrames) / Math.max(1, progress.totalFrames)) : 0,
  )
  const duration = $derived((settings.timeRange[1] - settings.timeRange[0]) / settings.rate)
  const plotted = $derived(plotsOf(view).length)

  const change = (next: Partial<VideoSettings>) => (settings = { ...settings, ...next })

  function toggle(shown: VideoView, on: boolean): void {
    change({
      views: on ? [...settings.views, shown] : settings.views.filter((item) => item !== shown),
    })
  }

  /** Set one end of the times exported. */
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

  /** Export the video to a file the reader picks, written as the video is made. */
  async function start(): Promise<void> {
    if (busy || blocked !== null || !view.summary) return
    const chosen = settings
    const state = view
    const control = (stop = new AbortController())
    const { signal } = control
    status = 'running'
    cancelled = false
    error = null
    progress = null
    bridge.send({ kind: 'busy', busy: true })
    let file: number | null = null
    try {
      const name = view.summary.name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')
      file = await bridge.request(
        'videoOpen',
        { name: `${name}.${chosen.format}`, format: chosen.format },
        signal,
        0,
      )
      if (file === null) {
        status = 'idle'
        return
      }
      const cameras = await bridge.request(
        'videoData',
        { views: chosen.views, window: chosen.timeRange },
        signal,
        0,
      )
      if (!rows || !samples) throw new Error('The case could not be read.')
      const gpu = await owner.get(() => control.abort(new Error('WebGPU device lost.')))
      signal.throwIfAborted()
      const handle = file
      const output = new WritableStream<VideoWrite>({
        write: ({ position, bytes }) =>
          bridge.request('videoWrite', { file: handle, position, bytes }, undefined, 0),
      })
      await exportVideo(
        gpu,
        chosen,
        { state, rows, samples, placement, presentation, cameras },
        output,
        signal,
        (made) => (progress = made),
      )
      saved = (await bridge.request('videoClose', { file }, undefined, 0)) ?? ''
      file = null
      status = 'done'
    } catch (reason) {
      status = cancelled ? 'cancelled' : 'failed'
      // An export stopped for a reason fails with that reason, not with the abort it caused.
      const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : reason
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (file !== null)
        await bridge.request('videoClose', { file, abort: true }, undefined, 0).catch(() => {})
      bridge.send({ kind: 'busy', busy: false })
    }
  }

  onMount(() => {
    const stops = [
      bridge.on((message) => {
        if (message.kind !== 'state') return
        view = merged(view, message.state)
        appearance(view.settings)
        const run = view.run
        // The times start as the run's, and stay so until the reader sets them.
        if (run && run.domain[1] > run.domain[0] && (run.id !== seeded || !touched) && !busy) {
          if (run.id !== seeded) touched = false
          seeded = run.id
          const [start, end] = settings.timeRange
          if (start !== run.domain[0] || end !== run.domain[1])
            change({ timeRange: [run.domain[0], run.domain[1]] })
        }
        const offered = viewsOf(view).map(({ value }) => value)
        if (view.summary && settings.views.some((shown) => !offered.includes(shown)))
          change({ views: settings.views.filter((shown) => offered.includes(shown)) })
      }),
      receive(
        (data, begin, base) => {
          rows = base
          samples = data
          if (begin.placement) placement = begin.placement
          if (begin.presentation) presentation = begin.presentation
        },
        (reason) => stop?.abort(reason instanceof Error ? reason : new Error(String(reason))),
      ),
    ]
    bridge.send({ kind: 'ready' })
    return () => {
      stop?.abort()
      for (const off of stops) off()
      owner.dispose()
    }
  })
</script>

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
          bind:checked={() => settings.views.includes(shown.value), (on) => toggle(shown.value, on)}
        />
      {/each}
      {#if settings.views.includes('monitor')}
        <p class="c-note">
          {plotted > 0
            ? `Draws the ${plotted === 1 ? 'signal' : `${plotted} signals`} plotted in Monitor.`
            : 'Choose a signal in Monitor.'}
        </p>
      {/if}
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
      <p class="c-note">Views appear in selection order, with their current framing.</p>
    </Section>
    <Section label="Time">
      <div class="c-row c-setting-row">
        <label class="c-row__label" for={id + '-start'}>Start (s)</label>
        <input
          id={id + '-start'}
          class="c-input"
          type="number"
          step="any"
          min={range?.[0]}
          max={range?.[1]}
          value={settings.timeRange[0]}
          oninput={(event) => bound(0, event.currentTarget.valueAsNumber)}
        />
      </div>
      <div class="c-row c-setting-row">
        <label class="c-row__label" for={id + '-end'}>End (s)</label>
        <input
          id={id + '-end'}
          class="c-input"
          type="number"
          step="any"
          min={range?.[0]}
          max={range?.[1]}
          value={settings.timeRange[1]}
          oninput={(event) => bound(1, event.currentTarget.valueAsNumber)}
        />
      </div>
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
      <p class="c-note">
        Output duration: {Number.isFinite(duration) && duration > 0
          ? duration.toFixed(2) + ' s'
          : 'Choose a time range'}.
      </p>
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
      <p class="c-note">Writes directly to your file as the video is exported.</p>
    </Section>
  </fieldset>
  <div class="export__footer">
    <div class="export__actions">
      <button
        class="c-btn c-btn--primary"
        type="submit"
        disabled={busy || blocked !== null}
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
      {:else if status === 'failed'}
        <p class="c-note c-note--error" role="alert">{error}</p>
      {:else if status === 'done'}
        <p class="c-note" role="status" data-testid="video-done">Exported {saved}</p>
      {:else if status === 'cancelled'}
        <p class="c-note" role="status">Export cancelled.</p>
      {:else}
        <p class="c-note">
          {blocked ?? 'Playback and navigation remain available during export.'}
        </p>
      {/if}
    </div>
  </div>
</form>

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
