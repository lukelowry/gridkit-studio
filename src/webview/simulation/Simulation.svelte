<!-- The simulation's parameters as one sheet of rows. Run and Stop are the view's title actions. -->
<script lang="ts">
  import { onMount } from 'svelte'

  import type { ViewState } from '../../messages.js'
  import { withUnit } from '../../schema.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'

  let view = $state.raw<ViewState>({})
  let values = $state.raw<Record<string, unknown>>({})
  const parameters = $derived(
    Object.entries(view.summary?.parameters ?? {}).filter(
      ([name]) => name !== 'output_format' && (!name.startsWith('fault_') || values.fault === true),
    ),
  )

  function update(name: string, value: unknown) {
    values = { ...values, [name]: value }
    bridge.send({ kind: 'values', uri: view.uri!, values })
  }

  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind !== 'state') return
      const incoming = message.state.values ?? {}
      if (view.uri !== message.state.uri || JSON.stringify(values) !== JSON.stringify(incoming))
        values = incoming
      view = merged(view, message.state)
      appearance(view.settings)
    })
    bridge.send({ kind: 'ready' })
    return stop
  })
</script>

<main class="study c-settings">
  {#if !view.summary}
    <div class="c-empty"><p class="c-empty__text">Loading case…</p></div>
  {:else}
    {#if view.stale}
      <p class="c-note c-note--warn" role="status">Resolve case errors before running.</p>
    {/if}
    <!-- Run is the native view-title action. -->
    <form onsubmit={(event) => event.preventDefault()}>
      {#each parameters as [name, spec] (name)}
        <div class="c-row c-setting-row">
          <label class="c-row__label" for={name} title={spec.description ?? ''}>
            {withUnit(spec.label ?? name, spec.unit)}
          </label>
          {#if spec.type === 'boolean'}
            <span class="c-check">
              <input
                id={name}
                type="checkbox"
                checked={Boolean(values[name] ?? ('default' in spec ? spec.default : false))}
                onchange={(event) => update(name, event.currentTarget.checked)}
              />
            </span>
          {:else if spec.type === 'choice'}
            <select
              id={name}
              class="c-select"
              value={String(values[name] ?? spec.default ?? '')}
              onchange={(event) => update(name, event.currentTarget.value)}
            >
              {#each spec.choices as choice (choice)}<option value={choice}>{choice}</option>{/each}
            </select>
          {:else if spec.type === 'number'}
            <span class="c-field">
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
                    event.currentTarget.value === ''
                      ? undefined
                      : Number(event.currentTarget.value),
                  )}
              />
            </span>
          {:else}
            <span class="c-field">
              <input
                id={name}
                type="text"
                value={String(values[name] ?? '')}
                placeholder={spec.type === 'reference' ? spec.to + '/native-ID' : ''}
                onchange={(event) => update(name, event.currentTarget.value)}
              />
            </span>
          {/if}
        </div>
      {/each}
    </form>
    {#if view.run}
      <p class="c-note" aria-live="polite">
        {view.run.state} · {view.run.frames.toLocaleString()} frames · {view.run.domain[1].toPrecision(
          5,
        )} s
      </p>
      {#if view.run.message}<p class="c-note c-note--error">{view.run.message}</p>{/if}
    {/if}
  {/if}
</main>

<style>
  .study {
    block-size: 100%;
    overflow: auto;
  }
</style>
