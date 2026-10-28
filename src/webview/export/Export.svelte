<script lang="ts">
  import { onMount } from 'svelte'

  import { formatNumber } from '../../shared/format.js'
  import type { VideoView, ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import Section from '../ui/Section.svelte'
  import Select from '../ui/Select.svelte'
  import Switch from '../ui/Switch.svelte'
  import { renderVideo } from './controller.js'
  import {
    DEFAULTS,
    exportable,
    type VideoProgress,
    type VideoSettings,
    videoTimes,
    viewsOf,
  } from './video.js'

  let view = $state.raw<ViewState>({})
  let rate = $state(1)
  let settings = $state.raw<VideoSettings>({
    ...DEFAULTS,
    ...bridge.state<{ settings?: Partial<VideoSettings> }>({}).settings,
  })
  let progress = $state.raw<VideoProgress | null>(null)
  let status = $state<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  let saved = $state('')
  let stop: AbortController | undefined
  let cancelled = false
  const busy = $derived(status === 'running')
  const views = $derived(viewsOf(view))
  const times = $derived(videoTimes(view))
  const job = $derived(times && { ...settings, timeRange: times, rate })
  const ready = $derived(exportable(job, view))
  const percent = $derived(
    progress ? Math.floor((100 * progress.frames) / Math.max(1, progress.total)) : 0,
  )
  $effect(() => bridge.save({ settings }))
  const change = (next: Partial<VideoSettings>) => (settings = { ...settings, ...next })
  function toggle(shown: VideoView, on: boolean) {
    change({
      views: on ? [...settings.views, shown] : settings.views.filter((item) => item !== shown),
    })
  }
  async function start() {
    const chosen = job
    if (busy || !exportable(chosen, view)) return
    const controller = (stop = new AbortController())
    status = 'running'
    cancelled = false
    progress = null
    bridge.send({ kind: 'busy', busy: true })
    try {
      const path = await renderVideo(chosen, view, controller.signal, (value) => (progress = value))
      saved = path ?? ''
      status = path ? 'done' : 'idle'
    } catch (error) {
      status = cancelled ? 'cancelled' : 'idle'
      if (!cancelled) bridge.report(error)
    } finally {
      if (stop === controller) stop = undefined
      bridge.send({ kind: 'busy', busy: false })
    }
  }
  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'clock') {
        rate = message.clock.rate
        return
      }
      if (message.kind !== 'state') return
      view = merged(view, message.state)
      const offered = viewsOf(view).map(({ value }) => value)
      if (view.summary && settings.views.some((shown) => !offered.includes(shown)))
        change({ views: settings.views.filter((shown) => offered.includes(shown)) })
    })
    const hooks = window as Window & { gridkitExport?: () => unknown }
    hooks.gridkitExport = () => ({ status, progress })
    bridge.ready()
    return () => {
      stop?.abort()
      off()
      delete hooks.gridkitExport
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
      <!-- The Monitor's time window and the playback speed choose these, as they do what plays. -->
      {#if times}
        <Section label="Time">
          <p class="c-note" data-testid="video-time">
            {formatNumber(times[0])} to {formatNumber(times[1])} s, as the Monitor shows, at
            {formatNumber(rate)}× playback speed: {formatNumber((times[1] - times[0]) / rate)} s of video.
          </p>
        </Section>
      {/if}
      <Section label="Output">
        <p class="c-note">MP4 / H.264</p>
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
            {progress ? 'Exporting video: ' + percent + '%' : 'Preparing video…'}
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
