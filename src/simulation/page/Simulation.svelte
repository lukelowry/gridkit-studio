<script lang="ts">
  import { onMount, tick } from 'svelte'

  import { vscode } from '../../webview/client.js'
  import { type FaultInput, validateFault } from '../faults.js'
  import { labels } from '../labels.js'
  import type { DraftValue, Request, SimulationState, ToSimulation } from '../messages.js'

  const groups = [
    { title: '', keys: ['tmax', 'dt_monitor'] },
    {
      title: 'Solver options',
      keys: ['dt_fixed', 'rel_tol', 'abs_tol', 'max_steps', 'consistent_ic_type'],
    },
    {
      title: 'Output and comparison',
      keys: ['output_file', 'reference_file', 'error_tolerance', 'error_type', 'abs_err_threshold'],
    },
  ] as const
  const keys = groups.flatMap((group) => [...group.keys])
  type Setting = (typeof keys)[number]
  const choices: Partial<Record<Setting, readonly { value: string; label: string }[]>> = {
    consistent_ic_type: [
      { value: 'y', label: 'y' },
      { value: 'ya_ydp', label: 'ya_ydp' },
    ],
    error_type: [
      { value: 'relative', label: 'Relative' },
      { value: 'absolute', label: 'Absolute' },
    ],
  }
  const faultFields = [
    { key: 'start', label: 'Start (s)' },
    { key: 'duration', label: 'Duration (s)' },
    { key: 'resistance', label: 'Resistance (p.u.)' },
    { key: 'reactance', label: 'Reactance (p.u.)' },
  ] as const
  let model = $state<SimulationState>()
  let local = $state<{ id: string; value: DraftValue }>()
  let values = $state<Record<string, string>>({})
  let busy = $state(false)
  let error = $state('')
  let startInput = $state<HTMLInputElement>()
  const fault = $derived(local?.value.kind === 'fault' ? local.value : undefined)
  const editing = $derived(!!local)
  const settingsRevision = $derived(local?.value.kind === 'settings' ? model?.revision : undefined)
  const stale = $derived(!!local && model?.draft?.id === local.id && model.draft.stale)
  const numericFault = $derived.by((): FaultInput => ({
    bus: fault?.bus ?? NaN,
    start: number(fault?.values.start),
    duration: number(fault?.values.duration),
    resistance: number(fault?.values.resistance),
    reactance: number(fault?.values.reactance),
  }))
  const faultErrors = $derived(validateFault(numericFault, model?.input?.tmax ?? 0))
  const clearTime = $derived(numericFault.start + numericFault.duration)
  function number(value?: string): number {
    return value?.trim() ? Number(value) : NaN
  }
  function format(value: number): string {
    return String(Number(value.toPrecision(12)))
  }
  function send(message: Request) {
    vscode.postMessage($state.snapshot(message))
  }
  function resetValues() {
    const input = model?.input
    values = input
      ? Object.fromEntries(
          keys.map((key) => [
            key,
            input[key] === undefined
              ? ''
              : Array.isArray(input[key])
                ? input[key].join(', ')
                : String(input[key]),
          ]),
        )
      : {}
  }
  function update(value: DraftValue) {
    const current = model
    if (!current) return
    local = { id: local?.id ?? crypto.randomUUID(), value }
    error = ''
    send({
      type: 'edit',
      owner: current.owner,
      revision: current.revision,
      draftId: local.id,
      value,
    })
  }
  function changed(key: string, value: string) {
    values[key] = value
    update({ kind: 'settings', values: { ...values } })
  }
  function faultChanged(key: string, value: string) {
    if (fault) update({ ...fault, values: { ...fault.values, [key]: value } })
  }
  function submit() {
    if (!model || !local) return
    busy = true
    send({ type: 'submit', owner: model.owner, draftId: local.id, value: local.value })
  }
  function cancel() {
    if (!model || !local) return
    busy = true
    send({ type: 'cancel', owner: model.owner, draftId: local.id })
  }
  async function editFault(row: SimulationState['faults'][number]) {
    update({
      kind: 'fault',
      on: row.interval.on,
      bus: row.value.bus,
      label: row.label,
      values: Object.fromEntries(faultFields.map(({ key }) => [key, String(row.value[key])])),
    })
    await tick()
    startInput?.focus()
  }
  onMount(() => {
    const receive = async (event: MessageEvent<ToSimulation>) => {
      const message = event.data
      if (message.type === 'state') {
        const switched = model?.owner !== message.owner
        model = message
        if (switched || (!local && message.draft)) {
          local = message.draft ? { id: message.draft.id, value: message.draft.value } : undefined
          busy = false
          error = ''
          if (local?.value.kind === 'settings') values = { ...local.value.values }
          if (fault) {
            await tick()
            startInput?.focus()
          }
        }
        if (!local) resetValues()
      } else if (
        message.owner === model?.owner &&
        (!message.draftId || message.draftId === local?.id)
      ) {
        busy = false
        if (message.ok) {
          if (message.draftId) local = undefined
          error = ''
          resetValues()
        } else error = message.message ?? 'The edit could not be applied.'
      }
    }
    window.addEventListener('message', receive)
    send({ type: 'ready' })
    const focus = () => send({ type: 'focus' })
    window.addEventListener('focus', focus)
    return () => {
      window.removeEventListener('message', receive)
      window.removeEventListener('focus', focus)
    }
  })
</script>

{#if model?.caseName}
  {@const owner = model.owner}
  {@const revision = model.revision}
  <header>
    <div class="case-name" title={model.caseName}>{model.caseName}</div>
    <button
      class="configuration"
      disabled={editing || busy || model.running}
      onclick={() => send({ type: 'configuration', owner })}
      title="Choose simulation configuration"
    >
      {model.configuration || 'Choose configuration'}
    </button>
  </header>
  {#if model.notice}
    <div class="notice" role="status">
      <p>{model.notice}</p>
      <button class="link" onclick={() => send({ type: 'terminal', owner })}>Show Terminal</button>
    </div>
  {/if}
  {#if stale}<p class="error" role="alert">
      The case or configuration changed. Cancel this edit to load the current values.
    </p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if model.input}
    {#if !fault}
      <form
        onsubmit={(event) => {
          event.preventDefault()
          busy = true
          submit()
        }}
      >
        <fieldset disabled={!!fault || busy || model.running || stale}>
          {#snippet fields(groupKeys: readonly Setting[])}
            {#each groupKeys as key}
              <label class="setting">
                <span>{labels[key]}</span>
                {#if choices[key]}
                  <select
                    name={key}
                    bind:value={values[key]}
                    onchange={(event) => changed(key, event.currentTarget.value)}
                  >
                    <option value="">GridKit default</option>
                    {#each choices[key] ?? [] as choice}
                      <option value={choice.value}>{choice.label}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    name={key}
                    bind:value={values[key]}
                    oninput={(event) => changed(key, event.currentTarget.value)}
                    inputmode={key.endsWith('_file') ? 'text' : 'decimal'}
                    placeholder={key === 'tmax' ? '' : 'GridKit default'}
                  />
                {/if}
              </label>
            {/each}
          {/snippet}
          {#each groups as group}
            {#if group.title}
              <details>
                <summary>{group.title}</summary>
                {@render fields(group.keys)}
              </details>
            {:else}
              {@render fields(group.keys)}
            {/if}
          {/each}
        </fieldset>
        {#if settingsRevision !== undefined}<div class="actions">
            <button class="primary" disabled={busy || stale || model.running} type="submit">
              Apply
            </button>
            <button type="button" disabled={busy} onclick={cancel}>Cancel</button>
          </div>{/if}
      </form>
    {/if}
    <section aria-labelledby="fault-heading">
      <h2 id="fault-heading">Faults</h2>
      {#if fault}
        <form
          class="fault-editor"
          onsubmit={(event) => {
            event.preventDefault()
            busy = true
            submit()
          }}
        >
          <h3>{fault.label}</h3>
          <fieldset disabled={busy || model.running || stale}>
            <label class="setting">
              <span>Start (s)</span>
              <input
                name="fault-start"
                bind:this={startInput}
                inputmode="decimal"
                value={fault.values.start}
                oninput={(event) => faultChanged('start', event.currentTarget.value)}
                aria-invalid={!!faultErrors.start}
                aria-describedby="start-error"
              />
            </label>
            {#if faultErrors.start}<p id="start-error" class="field-error">
                {faultErrors.start}
              </p>{/if}
            <label class="setting">
              <span>Duration (s)</span>
              <input
                name="fault-duration"
                inputmode="decimal"
                value={fault.values.duration}
                oninput={(event) => faultChanged('duration', event.currentTarget.value)}
                aria-invalid={!!faultErrors.duration}
                aria-describedby="duration-error"
              />
            </label>
            {#if faultErrors.duration}<p id="duration-error" class="field-error">
                {faultErrors.duration}
              </p>{/if}
            <p class="clear-time" aria-live="polite">
              {Number.isFinite(clearTime)
                ? `Clears at ${format(clearTime)} s`
                : 'Enter start and duration to set the clear time.'}
            </p>
            <details>
              <summary>
                Impedance <span>R {fault.values.resistance}, X {fault.values.reactance} p.u.</span>
              </summary>
              {#each faultFields.slice(2) as field}<label class="setting">
                  <span>{field.label}</span>
                  <input
                    name={'fault-' + field.key}
                    inputmode="decimal"
                    value={fault.values[field.key]}
                    oninput={(event) => faultChanged(field.key, event.currentTarget.value)}
                    aria-invalid={!!faultErrors[field.key]}
                  />
                </label>
                {#if faultErrors[field.key]}<p class="field-error">{faultErrors[field.key]}</p>{/if}
              {/each}
            </details>
          </fieldset>
          <div class="actions">
            <button
              class="primary"
              type="submit"
              disabled={busy || stale || model.running || Object.keys(faultErrors).length > 0}
            >
              {fault.on === undefined ? 'Add Fault' : 'Apply'}
            </button>
            <button type="button" disabled={busy} onclick={cancel}>Cancel</button>
          </div>
        </form>
      {/if}
      {#each model.faults as row (row.interval.on)}
        {#if row.interval.on !== fault?.on}
          <div class="fault-row">
            <button
              class="link fault-label"
              title="Select bus in linked views"
              onclick={() => send({ type: 'select', owner, revision, index: row.interval.on })}
            >
              {row.label}
            </button>
            <div class="fault-time">
              {format(row.value.start)}–{format(row.value.start + row.value.duration)} s
            </div>
            <div class="row-actions">
              <button disabled={editing || busy || model.running} onclick={() => editFault(row)}>
                Edit
              </button>
              <button
                disabled={editing || busy || model.running}
                onclick={() => {
                  busy = true
                  send({ type: 'removeFault', owner, revision, index: row.interval.on })
                }}
              >
                Remove
              </button>
            </div>
          </div>
        {/if}
      {/each}
      {#if !model.faults.length && !fault}<p class="empty">
          No faults scheduled. Use Add Fault in the view toolbar or a bus context menu.
        </p>{/if}
      {#if model.events.length}
        <details>
          <summary>
            Other events <span>{model.events.length}</span>
          </summary>
          <p class="empty">These transitions are preserved individually.</p>
          {#each model.events as event}<div class="fault-row">
              <span>{event.label}</span>
              <div class="row-actions">
                <button
                  disabled={editing || busy || model.running}
                  onclick={() => send({ type: 'editEvent', owner, revision, index: event.index })}
                >
                  Edit
                </button>
                <button
                  disabled={editing || busy || model.running}
                  onclick={() => {
                    busy = true
                    send({ type: 'removeEvent', owner, revision, index: event.index })
                  }}
                >
                  Remove
                </button>
              </div>
            </div>{/each}
        </details>
      {/if}
    </section>
  {/if}
{:else}<p class="empty">Open a case to configure DynamicSimulation.</p>{/if}
