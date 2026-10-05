<!-- Run the simulation; what it records is chosen in the native Monitored Signals view. -->
<script lang="ts">
  import type { InputValue, Parameter } from '@latkit/model'
  import { onMount } from 'svelte'

  import type { ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  import Icon from '../ui/Icon.svelte'
  import Form from './Form.svelte'
  import { type Choice, labelOf } from './rows.js'
  import { problemOf, valueOf } from './values.js'

  let view = $state.raw<ViewState>({})
  /** What the reader entered, by parameter name; one left out takes its default. */
  let values = $state.raw<Readonly<Record<string, InputValue>>>({})
  /** Each entry's text as typed, by parameter name. */
  let text = $state.raw<Readonly<Record<string, string>>>({})
  /** Each type's elements as choices, read once for each revision of the case. */
  let read: Record<string, Promise<readonly Choice[]>> = {}
  let revision: number | undefined

  const summary = $derived(view.summary)
  const run = $derived(view.run)
  const running = $derived(run?.state === 'running')
  /** The parameters the form shows: a fault's, only while there is one. */
  const parameters = $derived(
    Object.entries(summary?.parameters ?? {}).filter(
      ([name]) => !name.startsWith('fault_') || values.fault === true,
    ),
  )
  const value = (name: string, parameter: Parameter): InputValue | undefined =>
    Object.hasOwn(values, name)
      ? values[name]
      : 'default' in parameter
        ? parameter.default
        : undefined
  /** What keeps each parameter from running, by name. */
  const problems = $derived.by(() => {
    const found: Record<string, string> = {}
    for (const [name, parameter] of parameters) {
      const problem = problemOf(parameter, labelOf(name, parameter), value(name, parameter))
      if (problem !== null) found[name] = problem
    }
    return found
  })
  const invalid = $derived(Object.keys(problems).length > 0)
  /** How far through its span the run under way is; null until its command says how long it is. */
  const percent = $derived(
    run?.span && run.span[1] > run.span[0]
      ? Math.round((100 * (run.domain[1] - run.span[0])) / (run.span[1] - run.span[0]))
      : null,
  )
  /** How many values the next run records. */
  const selectedCount = $derived(
    (view.outputs ?? []).reduce((n, output) => n + output.select.length, 0),
  )
  /** Where the newest run stands, as the bar reads it; nothing before any. */
  const standing = $derived.by(() => {
    if (!run) return ''
    const frames = `${run.frames.toLocaleString()} samples`
    switch (run.state) {
      case 'running':
        return percent === null ? frames : `${percent}%`
      case 'complete':
        return frames
      case 'failed':
        return 'Failed'
      default:
        return 'Stopped'
    }
  })

  /** The elements of `type` as a dropdown offers them: each by its id, and its name where it has one. */
  function elements(type: string): Promise<readonly Choice[]> {
    return (read[type] ??= bridge.request('elements', { type }).then((found) =>
      found.map(({ id, name }) => {
        const short = id.slice(type.length + 1)
        return { value: id, label: name !== '' && name !== short ? `${short} - ${name}` : short }
      }),
    ))
  }

  function give(name: string, entered: InputValue | undefined, typed?: string): void {
    const next = { ...values }
    if (entered === undefined) delete next[name]
    else next[name] = entered
    values = next
    const texts = { ...text }
    if (typed === undefined) delete texts[name]
    else texts[name] = typed
    text = texts
    bridge.send({ kind: 'values', uri: view.uri!, values: next })
  }

  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind !== 'state') return
      const incoming = (message.state.values ?? {}) as Readonly<Record<string, InputValue>>
      // Another case, or values set elsewhere (a fault from a bus's menu), replace what was typed.
      if (view.uri !== message.state.uri || JSON.stringify(values) !== JSON.stringify(incoming)) {
        values = incoming
        text = {}
      }
      view = merged(view, message.state)
      appearance(view.settings)
      if (view.summary?.version !== revision) {
        revision = view.summary?.version
        read = {}
      }
    })
    bridge.send({ kind: 'ready' })
    return stop
  })
</script>

<div class="study c-settings" data-testid="study-panel">
  {#if !summary}
    {#if view.error}
      <p class="c-note c-note--error" role="alert">{view.error}</p>
    {:else}
      <div class="c-empty"><p class="c-empty__text">Loading case…</p></div>
    {/if}
  {:else}
    <div class="study__draft">
      <div class="study__bar">
        <span class="study__standing" role="status">{standing}</span>
        {#if running}
          <button
            type="button"
            class="c-btn c-btn--sm"
            title="Stop"
            aria-label="Stop the run"
            data-testid="study-stop"
            onclick={() => bridge.command('stop')}
          >
            <Icon name="stop" /> Stop
          </button>
        {:else}
          <button
            type="button"
            class="c-btn c-btn--sm"
            title={view.stale
              ? 'Resolve case errors to run'
              : invalid
                ? 'Fix the form to run'
                : selectedCount === 0
                  ? 'Choose at least one monitored signal to run'
                  : 'Run'}
            aria-label="Run DynamicSimulation"
            disabled={invalid || view.stale || selectedCount === 0}
            data-testid="study-run"
            onclick={() => bridge.command('run')}
          >
            <Icon name="play" /> Run
          </button>
        {/if}
      </div>
      <div class="study__progress-slot">
        {#if running}
          <div
            class="study__progress"
            role="progressbar"
            aria-valuenow={percent ?? undefined}
            aria-label="Progress"
          >
            {#if percent !== null}
              <span
                class="study__progress-done"
                style:transform={`scaleX(${percent / 100})`}
              ></span>
            {/if}
          </div>
        {/if}
      </div>
      {#if view.stale}
        <p class="c-note c-note--warn" role="status">
          {view.error ?? 'Source is updating. Wait for the current revision before running.'}
        </p>
      {:else if run?.state === 'failed' && run.message}
        <p class="c-note c-note--error" role="alert">{run.message}</p>
      {/if}
      {#if selectedCount === 0}
        <div class="c-note study__signals" role="status">
          <span>Choose the signals to record before running.</span>
          <button
            type="button"
            class="c-btn c-btn--sm"
            data-testid="study-signals"
            onclick={() => bridge.command('chooseSignals')}
          >
            Choose monitored signals
          </button>
        </div>
      {/if}
      <Form
        {parameters}
        {text}
        {problems}
        disabled={running}
        {value}
        {elements}
        onenter={(name, parameter, entered) => give(name, valueOf(parameter, entered), entered)}
        ontoggle={(name, on) => give(name, on)}
      />
    </div>
  {/if}
</div>

<style>
  /* Number inputs share one width in mono digits (read by Field). */
  .study {
    --field-input-w: 9ch;
    display: flex;
    flex-direction: column;
    block-size: 100%;
    overflow-y: auto;
  }

  .study__draft {
    margin-block-end: var(--spacing-lg);
  }

  .study__bar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--spacing-sm);
    padding-block-end: var(--spacing-sm);
  }

  .study__signals {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .study__standing {
    margin-inline-end: auto;
    color: var(--color-text-2);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  /* A hairline that fills as frames arrive; without a known end it stays an empty track. */
  .study__progress-slot {
    block-size: 2px;
    flex-shrink: 0;
  }

  .study__progress {
    block-size: 2px;
    overflow: hidden;
    background: var(--color-surface-3);
  }

  /* Scaled rather than resized, so a report of frames costs no layout; eased linearly, since an
     easing curve would misstate the rate. */
  .study__progress-done {
    display: block;
    block-size: 100%;
    background: var(--color-primary-text);
    transform-origin: left;
    transition: transform var(--motion-mid) linear;
  }
</style>
