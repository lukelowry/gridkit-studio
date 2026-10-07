<!-- The run form: a DynamicSimulation, or a ContingencyAnalysis that faults every bus in turn.
  The view's title bar starts and stops the run and says how far it has come, and the signals it
  records are chosen in the native Monitored Signals view. Why a run cannot start or failed is said
  in a notification and the log, never here. -->
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
  /** The values as the extension last sent them, and those this view sent since others set them. */
  let told = '{}'
  let own = new Set<string>()
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
    own.add(JSON.stringify(next))
    bridge.send({ kind: 'values', uri: view.uri!, values: next })
  }

  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind !== 'state') return
      const incoming = (message.state.values ?? {}) as Readonly<Record<string, InputValue>>
      const sent = JSON.stringify(incoming)
      // Another case, or values set elsewhere (a bus menu's fault), discard the typed text. State
      // the extension sent before it heard of this view's entries holds values the view already
      // had, or sent itself, which its latest entry stands over.
      if (view.uri !== message.state.uri || (sent !== told && !own.has(sent))) {
        values = incoming
        text = {}
        own = new Set()
      }
      told = sent
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
    {#if !view.error}
      <div class="c-empty">
        <p class="c-empty__text">Loading case…</p>
      </div>
    {/if}
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
</style>
