<script lang="ts">
  import { onMount } from 'svelte'

  import { formatNumber } from '../../shared/format.js'
  import type { VideoView, ViewState } from '../../shared/messages.js'
  import { monitorName } from '../../shared/monitors.js'
  import {
    exportDefaults,
    type ExportSettings,
    nearest,
    validateSettings,
  } from '../../shared/settings.js'
  import { advance, type ClockState, IDLE } from '../../shared/transport.js'
  import { bridge } from '../bridge.js'
  import NumberField from '../ui/NumberField.svelte'
  import Section from '../ui/Section.svelte'
  import Select from '../ui/Select.svelte'
  import Switch from '../ui/Switch.svelte'
  import { renderExport } from './controller.js'
  import {
    CHOICES,
    type ExportChoices,
    type ExportJob,
    framesOf,
    problemOf,
    videoTimes,
    viewsOf,
  } from './video.js'

  /** Common sizes; any other size is set by width and height. */
  const SIZES = [
    [1280, 720, '720p'],
    [1920, 1080, '1080p'],
    [2560, 1440, '1440p'],
    [3840, 2160, '4K'],
    [1080, 1080, 'Square'],
    [1080, 1920, 'Portrait'],
  ] as const
  const FORMATS = [
    { value: 'video', label: 'Video · MP4' },
    { value: 'png', label: 'Image · PNG' },
    { value: 'jpeg', label: 'Image · JPEG' },
    { value: 'webp', label: 'Image · WebP' },
  ] as const

  let viewState = $state.raw<ViewState>({})
  /** The clock, and when it arrived, to read the playhead at any moment. */
  let clock = $state.raw<{ state: ClockState; at: number }>({ state: IDLE, at: 0 })
  /** The Export settings, changed here at once and in VS Code's settings after. */
  let style = $state.raw<ExportSettings>(exportDefaults)
  let choices = $state.raw<ExportChoices>({
    ...CHOICES,
    ...bridge.state<{ choices?: Partial<ExportChoices> }>({}).choices,
  })
  let running = $state<AbortController>()
  const video = $derived(choices.format === 'video')
  const views = $derived(viewsOf(viewState))
  const times = $derived(videoTimes(viewState))
  const playhead = $derived(clock.state.t)
  const job = $derived.by((): ExportJob => {
    const from = choices.from ?? times?.[0] ?? NaN
    const to = choices.to ?? times?.[1] ?? NaN
    return {
      format: choices.format,
      views: choices.views,
      layout: choices.layout,
      timeRange: video ? [from, to] : [playhead, playhead],
      rate: choices.rate ?? clock.state.rate,
      settings: style,
    }
  })
  const problem = $derived(
    viewState.results?.frames
      ? problemOf(job, viewState)
      : 'Run a simulation or open results to export them.',
  )
  const size = $derived(
    SIZES.find(
      ([width, height]) => width === style['export.width'] && height === style['export.height'],
    ),
  )
  const megabits = $derived(
    (style['export.width'] *
      style['export.height'] *
      style['export.frameRate'] *
      style['export.bitsPerPixel']) /
      1e6,
  )
  const shownNames = $derived(
    (viewState.shown ?? []).map((monitor) => monitorName(viewState.summary?.definition, monitor)),
  )

  $effect(() => bridge.save({ choices }))
  const choose = (next: Partial<ExportChoices>) => (choices = { ...choices, ...next })
  /** Sets an Export setting here, then in VS Code. A value no setting takes is refused. */
  function set<K extends keyof ExportSettings>(key: K, value: ExportSettings[K] | undefined) {
    if (value === undefined) return
    const coerced = nearest(key, value) as ExportSettings[K]
    try {
      validateSettings({ [key]: coerced })
    } catch {
      return
    }
    style = { ...style, [key]: coerced }
    bridge.send({ kind: 'display', values: { [key]: coerced } })
  }
  function toggle(view: VideoView, on: boolean) {
    choose({
      views: on ? [...choices.views, view] : choices.views.filter((each) => each !== view),
    })
  }
  async function start() {
    if (running || problem) return
    const chosen: ExportJob = video ? job : { ...job, timeRange: [now(), now()] }
    const controller = (running = new AbortController())
    let reported = -1
    try {
      await renderExport(chosen, viewState, controller.signal, (status) => {
        // A notification shows whole percents, so send only those.
        const percent = Math.floor((100 * status.done) / status.total)
        if (percent === reported) return
        reported = percent
        bridge.send({ kind: 'export', status })
      })
    } catch (error) {
      if (!controller.signal.aborted) bridge.report(error)
    } finally {
      running = undefined
      bridge.send({ kind: 'export', status: null })
    }
  }
  /** The playhead now, which moves while playing. */
  const now = () => advance(clock.state, performance.now() - clock.at).t
  onMount(() => {
    const off = bridge.on((message) => {
      if (message.kind === 'clock') {
        clock = { state: message.clock, at: performance.now() }
        return
      }
      if (message.kind === 'action') {
        if (message.command === 'cancelExport') running?.abort()
        else if (message.command === 'exportVideo') choose({ format: 'video' })
        return
      }
      if (message.kind !== 'state') return
      const previous = viewState
      viewState = message.state
      if (viewState.exportSettings) style = viewState.exportSettings
      // Times chosen for other results do not carry over.
      if (previous.results?.id !== viewState.results?.id)
        choose({ from: undefined, to: undefined, rate: undefined })
      const offered = viewsOf(viewState).map(({ value }) => value)
      if (viewState.summary && choices.views.some((view) => !offered.includes(view)))
        choose({ views: choices.views.filter((view) => offered.includes(view)) })
    })
    const hooks = window as Window & { gridkitExport?: () => unknown }
    hooks.gridkitExport = () => ({ running: !!running, problem, job })
    bridge.ready()
    return () => {
      running?.abort()
      off()
      delete hooks.gridkitExport
    }
  })
</script>

{#if !viewState.uri}
  <div class="c-empty"><p class="c-empty__text">Open a GridKit case.</p></div>
{:else}
  <form
    class="export"
    data-testid="export"
    onsubmit={(event) => {
      event.preventDefault()
      if (running) running.abort()
      else void start()
    }}
  >
    <fieldset disabled={!!running} class="export__fields">
      <Select
        label="Format"
        options={FORMATS}
        data-testid="export-format"
        bind:value={
          () => (video ? 'video' : style['export.imageFormat']),
          (format) => {
            if (format === 'video') choose({ format: 'video' })
            else if (format) {
              choose({ format: 'image' })
              set('export.imageFormat', format)
            }
          }
        }
      />
      <Section label="Views">
        {#each views as option (option.value)}
          <Switch
            label={option.label}
            bind:checked={
              () => choices.views.includes(option.value), (on) => toggle(option.value, on)
            }
          />
        {/each}
        {#if choices.views.includes('monitor') && shownNames.length}
          <p class="c-note">{shownNames.join(', ')}, as the Monitor shows.</p>
        {/if}
        <Select
          label="Layout"
          disabled={choices.views.length < 2}
          options={[
            { value: 'column', label: 'Stacked' },
            { value: 'row', label: 'Side by side' },
          ]}
          bind:value={
            () => choices.layout,
            (layout) => {
              if (layout) choose({ layout })
            }
          }
        />
      </Section>
      <Section label="Time">
        {#if video}
          <NumberField
            label="From"
            unit="s"
            value={choices.from}
            placeholder={times && formatNumber(times[0])}
            onchange={(from) => choose({ from })}
          />
          <NumberField
            label="To"
            unit="s"
            value={choices.to}
            placeholder={times && formatNumber(times[1])}
            onchange={(to) => choose({ to })}
          />
          <NumberField
            label="Speed"
            unit="×"
            value={choices.rate}
            placeholder={formatNumber(clock.state.rate)}
            onchange={(rate) => choose({ rate })}
          />
          {#if !problem}
            <p class="c-note" data-testid="video-time">
              {formatNumber((job.timeRange[1] - job.timeRange[0]) / job.rate)} s of video,
              {framesOf(job).toLocaleString()} frames. Empty fields follow the Monitor's window and the
              playback speed.
            </p>
          {/if}
        {:else}
          <p class="c-note">At {formatNumber(playhead)} s, where the playhead is.</p>
        {/if}
      </Section>
      <Section label="Output">
        <Select
          label="Size"
          options={[
            ...SIZES.map(([width, height, label]) => ({ value: `${width}x${height}`, label })),
            ...(size ? [] : [{ value: 'custom', label: 'Custom' }]),
          ]}
          bind:value={
            () => (size ? `${size[0]}x${size[1]}` : 'custom'),
            (value) => {
              const found = SIZES.find(([width, height]) => `${width}x${height}` === value)
              if (!found) return
              set('export.width', found[0])
              set('export.height', found[1])
            }
          }
        />
        <NumberField
          label="Width"
          unit="px"
          step={1}
          min={4}
          value={style['export.width']}
          onchange={(width) => set('export.width', width)}
        />
        <NumberField
          label="Height"
          unit="px"
          step={1}
          min={2}
          value={style['export.height']}
          onchange={(height) => set('export.height', height)}
        />
        <NumberField
          label="Scale"
          unit="×"
          value={style['export.scale']}
          onchange={(scale) => set('export.scale', scale)}
        />
        {#if video}
          <NumberField
            label="Frame rate"
            unit="fps"
            value={style['export.frameRate']}
            onchange={(rate) => set('export.frameRate', rate)}
          />
          <NumberField
            label="Bits per pixel"
            value={style['export.bitsPerPixel']}
            onchange={(bits) => set('export.bitsPerPixel', bits)}
          />
          <p class="c-note">About {formatNumber(Number(megabits.toPrecision(2)))} Mbit/s.</p>
        {:else if style['export.imageFormat'] === 'jpeg'}
          <NumberField
            label="Quality"
            step={1}
            min={1}
            max={100}
            value={style['export.jpegQuality']}
            onchange={(quality) => set('export.jpegQuality', quality)}
          />
        {:else}
          <Switch
            label="Transparent background"
            bind:checked={() => style['export.transparent'], (on) => set('export.transparent', on)}
          />
        {/if}
      </Section>
      <Section label="Style">
        <Select
          label="Theme"
          options={[
            { value: 'auto', label: 'Match VS Code' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          bind:value={
            () => style['export.theme'],
            (theme) => {
              if (theme) set('export.theme', theme)
            }
          }
        />
        <Switch
          label="Case name and time"
          bind:checked={() => style['export.caption'], (on) => set('export.caption', on)}
        />
        <Switch
          label="Color legends"
          bind:checked={() => style['export.legend'], (on) => set('export.legend', on)}
        />
      </Section>
    </fieldset>
    <div class="export__footer">
      <button
        class="c-btn {running ? 'c-btn--secondary' : 'c-btn--primary'} export__start"
        type="submit"
        disabled={!running && !!problem}
        data-testid="export-start"
      >
        {running ? 'Cancel' : video ? 'Export Video' : 'Export Image'}
      </button>
      {#if problem && !running}<p class="c-note export__problem">{problem}</p>{/if}
    </div>
  </form>
{/if}

<style>
  .export {
    --row-label: 7.5rem;
    display: flex;
    flex-direction: column;
    block-size: 100%;
    overflow-y: auto;
  }

  .export__fields {
    min-inline-size: 0;
    padding-block: var(--spacing-xs);
  }

  .export__footer {
    position: sticky;
    inset-block-end: 0;
    margin-block-start: auto;
    padding: var(--spacing-md) var(--spacing-sm);
    border-block-start: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .export__start {
    inline-size: 100%;
  }

  .export__problem {
    margin-inline: 0;
  }
</style>
