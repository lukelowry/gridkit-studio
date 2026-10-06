<!-- Command parameters as text fields, dropdowns and switches. -->
<script lang="ts">
  import type { InputValue, Parameter } from '@latkit/model'

  import { labelOf, textOf } from '../../shared/parameters.js'
  import Switch from '../ui/Switch.svelte'
  import Field from './Field.svelte'
  import { type Choice, rowOf } from './rows.js'

  let {
    parameters,
    text,
    problems,
    disabled,
    compact = false,
    value,
    elements,
    onenter,
    ontoggle,
  }: {
    /** Name and parameter pairs, in catalog order. */
    parameters: readonly (readonly [string, Parameter])[]
    /** Text as typed, by parameter name. */
    text: Readonly<Record<string, string>>
    /** Validation messages, by parameter name. */
    problems: Readonly<Record<string, string>>
    disabled: boolean
    /** Dropdowns without a label beside them, as where two share a row. */
    compact?: boolean
    /** The entered value, else the default. */
    value: (name: string, parameter: Parameter) => InputValue | undefined
    /** The choices for a reference parameter's target type. */
    elements: (type: string) => Promise<readonly Choice[]>
    onenter: (name: string, parameter: Parameter, text: string) => void
    ontoggle: (name: string, on: boolean) => void
  } = $props()
</script>

{#snippet field(name: string, parameter: Parameter, choices: readonly Choice[])}
  {#if parameter.type === 'boolean'}
    <Switch
      label={labelOf(name, parameter)}
      {disabled}
      data-testid={`field-${name}`}
      bind:checked={() => value(name, parameter) === true, (on) => ontoggle(name, on)}
    />
  {:else}
    <Field
      row={rowOf(name, parameter, choices)}
      value={text[name] ?? textOf(value(name, parameter))}
      error={problems[name]}
      {disabled}
      {compact}
      onvalue={(entered) => onenter(name, parameter, entered)}
    />
  {/if}
{/snippet}

{#each parameters as [name, parameter] (name)}
  {#if parameter.type === 'reference'}
    {#await elements(parameter.to)}
      <p class="c-note" role="status">
        Loading {labelOf(name, parameter).toLowerCase()} choices…
      </p>
    {:then choices}
      {@render field(name, parameter, choices)}
    {:catch}
      {@render field(name, parameter, [])}
    {/await}
  {:else}
    {@render field(name, parameter, [])}
  {/if}
{/each}
