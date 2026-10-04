<script lang="ts">
  import { onMount } from 'svelte'

  import type { ViewState } from '../messages.js'
  import { bridge } from './bridge.js'
  let view = $state<ViewState>({})
  let values = $state<Record<string, unknown>>({})
  const parameters = $derived(
    Object.entries(view.summary?.parameters ?? {}).filter(([name]) => name !== 'output_format'),
  )
  function update(name: string, value: unknown) {
    values = { ...values, [name]: value }
    bridge.send({ kind: 'values', uri: view.uri!, values: $state.snapshot(values) })
  }
  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind === 'state') {
        if (
          view.uri !== message.state.uri ||
          JSON.stringify(values) !== JSON.stringify(message.state.values ?? {})
        )
          values = message.state.values ?? {}
        view = message.state
      }
    })
    bridge.send({ kind: 'ready' })
    return stop
  })
</script>

<main>
  {#if !view.summary}
    <p class="muted">Open a case to configure and run a local simulation.</p>
  {:else}
    {#if view.stale}<p class="warning" role="status">Resolve case errors before running.</p>{/if}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        // Run is the native view-title action.
      }}
    >
      {#each parameters as [name, spec] (name)}
        {#if !name.startsWith('fault_') || (values.fault ?? false)}
          <label for={name} title={spec.description ?? ''}>
            {spec.label ?? name}{spec.unit ? ' [' + spec.unit + ']' : ''}
          </label>
          {#if spec.type === 'boolean'}
            <input
              id={name}
              type="checkbox"
              checked={Boolean(values[name] ?? ('default' in spec ? spec.default : false))}
              onchange={(event) => update(name, event.currentTarget.checked)}
            />
          {:else if spec.type === 'choice'}
            <select
              id={name}
              value={String(values[name] ?? spec.default ?? '')}
              onchange={(event) => update(name, event.currentTarget.value)}
            >
              {#each spec.choices as choice (choice)}<option value={choice}>{choice}</option>{/each}
            </select>
          {:else if spec.type === 'number'}
            <input
              id={name}
              type="number"
              value={(values[name] as number) ?? (spec.default as number) ?? ''}
              min={spec.min}
              max={spec.max}
              step={spec.integer ? 1 : 'any'}
              placeholder={spec.optional ? 'Default' : ''}
              onchange={(event) =>
                update(
                  name,
                  event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value),
                )}
            />
          {:else}
            <input
              id={name}
              type="text"
              value={String(values[name] ?? '')}
              placeholder={spec.type === 'reference' ? spec.to + '/native-ID' : ''}
              onchange={(event) => update(name, event.currentTarget.value)}
            />
          {/if}
        {/if}
      {/each}
    </form>
    {#if view.run}<p class="status" aria-live="polite">
        {view.run.state} · {view.run.frames.toLocaleString()} frames · {view.run.domain[1].toPrecision(
          5,
        )} s
      </p>
      {#if view.run.message}<p class="error">{view.run.message}</p>{/if}{/if}
  {/if}
</main>

<style>
  main {
    padding: 12px;
    height: 100vh;
    overflow: auto;
  }
  form {
    display: grid;
    grid-template-columns: minmax(80px, 1fr) minmax(70px, 1fr);
    align-items: center;
    gap: 8px;
    margin: 12px 0;
  }
  label {
    line-height: 1.4;
  }
  input,
  select {
    width: 100%;
  }
  input[type='checkbox'] {
    width: auto;
    justify-self: start;
    accent-color: var(--vscode-checkbox-foreground);
  }
  .status {
    padding: 8px 0;
    line-height: 1.6;
  }
</style>
