<!-- The run form: a DynamicSimulation, or a ContingencyAnalysis that faults every bus in turn.
  The view's title bar starts and stops the run, and the signals it records are chosen in the
  native Monitored Signals view. -->
<script lang="ts">
  import type { InputValue } from '@latkit/model'
  import { onMount } from 'svelte'

  import { PROGRAMS, type ViewState } from '../../shared/messages.js'
  import { enteredOf, formOf, problemsOf, valueOf, type Values } from '../../shared/parameters.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  import Select from '../ui/Select.svelte'
  import Form from './Form.svelte'
  import type { Choice } from './rows.js'

  let view = $state.raw<ViewState>({})
  let values = $state.raw<Values>({})
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
  /** A simulation's fault switch and its bus, side by side; an analysis faults every bus. */
  const { program, faulted, toggle, bus, fault, others } = $derived(
    formOf(summary?.parameters ?? {}, values),
  )
  /** Validation messages by parameter name. */
  const problems = $derived(problemsOf(summary?.parameters ?? {}, values))
  /** The contingencies with results, to show one at a time. */
  const contingencies = $derived(
    study
      ? study.buses.flatMap((bus, n) =>
          study.failed.includes(n) ? [] : [{ value: n, label: 'Bus ' + bus }],
        )
      : [],
  )
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

{#snippet form(shown: typeof others, disabled: boolean, compact = false)}
  <Form
    parameters={shown}
    {text}
    {problems}
    {disabled}
    {compact}
    value={(name, parameter) => enteredOf(values, name, parameter)}
    {elements}
    onenter={(name, parameter, entered) => give(name, valueOf(parameter, entered), entered)}
    ontoggle={(name, on) => give(name, on)}
  />
{/snippet}

<div class="study c-settings" data-testid="study-panel">
  {#if !summary}
    <div class="c-empty">
      <p class="c-empty__text">
        {view.error
          ? 'The case can be simulated once the problems listed in Problems are fixed.'
          : 'Loading case…'}
      </p>
    </div>
  {:else}
    <div class="study__draft">
      <div class="study__program">
        <Select
          label="Program"
          hideLabel
          compact
          options={Object.entries(PROGRAMS).map(([value, label]) => ({ value, label }))}
          disabled={running}
          data-testid="study-program"
          bind:value={() => program, (chosen) => chosen && give('program', chosen)}
        />
      </div>
      <p class="study__standing" role="status">{standing}</p>
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
        <p class="c-note c-note--warn" role="status">Simulation requires a valid case.</p>
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
          <span>Choose the signals to record before starting.</span>
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
      {#if toggle}
        <div class="study__fault">
          {@render form([toggle], running)}
          {#if bus}
            {@render form([bus], running || !faulted, true)}
          {/if}
        </div>
      {/if}
      {@render form(fault, running)}
      {@render form(others, running)}
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

  /* What to run; the view's title bar runs it. */
  .study__program {
    padding-block-end: var(--spacing-xs);
  }

  /* The fault's switch and its bus share a row until the panel is too narrow for both. */
  .study__fault {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: center;
    gap: var(--spacing-xs);
  }

  @container settings (max-width: 15rem) {
    .study__fault {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .study__signals {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm);
  }

  /* The newest run's status, under the bar once there is one. */
  .study__standing {
    padding-block-end: var(--spacing-2xs);
    color: var(--color-text-2);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .study__standing:empty {
    display: none;
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
