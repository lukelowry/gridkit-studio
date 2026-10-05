<!-- The run form: a DynamicSimulation, or a ContingencyAnalysis that faults every bus in turn.
  The signals a run records are chosen in the native Monitored Signals view. -->
<script lang="ts">
  import type { InputValue, Parameter } from '@latkit/model'
  import { onMount } from 'svelte'

  import { type Program, PROGRAMS, type ViewState } from '../../shared/messages.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  import Icon from '../ui/Icon.svelte'
  import Select from '../ui/Select.svelte'
  import Form from './Form.svelte'
  import { type Choice, labelOf } from './rows.js'
  import { problemOf, valueOf } from './values.js'

  let view = $state.raw<ViewState>({})
  /** Entered values by parameter name; a missing one takes its default. */
  let values = $state.raw<Readonly<Record<string, InputValue>>>({})
  /** Text as typed by parameter name, so formatting a value never rewrites an entry mid-edit. */
  let text = $state.raw<Readonly<Record<string, string>>>({})
  /** Element choices by type, cached per case revision. */
  let read: Record<string, Promise<readonly Choice[]>> = {}
  let revision: number | undefined

  const summary = $derived(view.summary)
  const run = $derived(view.run)
  /** Whether a run is under way, or Run was pressed and GridKit is starting. */
  const running = $derived(run?.state === 'running' || view.launching === true)
  const study = $derived(run?.contingency)
  const program = $derived((values.program ?? 'DynamicSimulation') as Program)
  /** A simulation's fault parameters show while its fault is on; an analysis faults every bus,
   *  so it shows the fault's timing and impedance alone. */
  const parameters = $derived(
    Object.entries(summary?.parameters ?? {}).filter(([name]) =>
      name === 'program'
        ? false
        : program === 'ContingencyAnalysis'
          ? name !== 'fault' && name !== 'fault_bus'
          : !name.startsWith('fault_') || values.fault === true,
    ),
  )
  /** The contingencies with results, to show one at a time. */
  const contingencies = $derived(
    study
      ? study.buses.flatMap((bus, n) =>
          study.failed.includes(n) ? [] : [{ value: n, label: 'Bus ' + bus }],
        )
      : [],
  )
  const value = (name: string, parameter: Parameter): InputValue | undefined =>
    Object.hasOwn(values, name)
      ? values[name]
      : 'default' in parameter
        ? parameter.default
        : undefined
  /** Validation messages by parameter name. */
  const problems = $derived.by(() => {
    const found: Record<string, string> = {}
    for (const [name, parameter] of parameters) {
      const problem = problemOf(parameter, labelOf(name, parameter), value(name, parameter))
      if (problem !== null) found[name] = problem
    }
    return found
  })
  const invalid = $derived(Object.keys(problems).length > 0)
  /** Run progress in percent: contingencies finished, or time covered; null until known. */
  const percent = $derived(
    study
      ? Math.round((100 * study.done) / study.buses.length)
      : run?.span && run.span[1] > run.span[0]
        ? Math.round((100 * (run.domain[1] - run.span[0])) / (run.span[1] - run.span[0]))
        : null,
  )
  /** How many fields the next run records. */
  const selectedCount = $derived(
    (view.outputs ?? []).reduce((n, output) => n + output.select.length, 0),
  )
  /** The newest run's status for the bar; empty before any run. */
  const standing = $derived.by(() => {
    if (view.launching) return 'Starting…'
    if (!run) return ''
    if (study && run.state === 'running')
      return `${study.done.toLocaleString()} of ${study.buses.length.toLocaleString()} contingencies`
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

  /** Choices for the elements of `type`, labeled by short id, and name where it differs. Choices
   *  that failed to load are reported, and asked for again the next time the form shows them. */
  function elements(type: string): Promise<readonly Choice[]> {
    const cached = read[type]
    if (cached) return cached
    const choices = bridge.request('elements', { type }).then((found) =>
      found.map(({ id, name }) => {
        const short = id.slice(type.length + 1)
        return { value: id, label: name !== '' && name !== short ? `${short} - ${name}` : short }
      }),
    )
    read[type] = choices
    choices.catch((reason) => {
      if (read[type] === choices) delete read[type]
      bridge.report(reason)
    })
    return choices
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
      // Another case, or values set elsewhere (a bus menu's fault), discard the typed text.
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
    <div class="c-empty">
      <p class="c-empty__text">
        {view.error
          ? 'The case can run once the problems listed in Problems are fixed.'
          : 'Loading case…'}
      </p>
    </div>
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
              ? 'Run waits for a valid revision of the case'
              : invalid
                ? 'Fix the form to run'
                : selectedCount === 0
                  ? 'Choose at least one monitored signal to run'
                  : 'Run'}
            aria-label={'Run ' + PROGRAMS[program].toLowerCase()}
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
        <p class="c-note c-note--warn" role="status">Run waits for a valid revision of the case.</p>
      {/if}
      {#if study && run?.state === 'complete'}
        <Select
          label="Contingency"
          options={contingencies}
          data-testid="study-contingency"
          bind:value={
            () => study.shown,
            (shown) => {
              if (shown !== null && shown !== study.shown) bridge.command('showContingency', shown)
            }
          }
        />
        {#if study.failed.length}
          <p class="c-note c-note--warn" role="status">
            {study.failed.length === 1 ? 'One contingency' : study.failed.length + ' contingencies'}
            failed: bus {study.failed.map((n) => study.buses[n]).join(', ')}.
          </p>
        {/if}
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
      <Select
        label="Study"
        options={Object.entries(PROGRAMS).map(([value, label]) => ({ value, label }))}
        disabled={running}
        data-testid="study-program"
        bind:value={() => program, (chosen) => chosen && give('program', chosen)}
      />
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
  .study {
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

  /* Reserves the bar's height so the form does not shift when a run starts. */
  .study__progress-slot {
    block-size: 2px;
    flex-shrink: 0;
  }

  /* A hairline that fills as frames arrive; an empty track until the span is known. */
  .study__progress {
    block-size: 2px;
    overflow: hidden;
    background: var(--color-surface-3);
  }

  /* Scaled, not resized, to avoid layout; linear, since easing would misstate the rate. */
  .study__progress-done {
    display: block;
    block-size: 100%;
    background: var(--color-primary-text);
    transform-origin: left;
    transition: transform var(--motion-mid) linear;
  }
</style>
