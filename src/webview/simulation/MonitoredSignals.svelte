<!-- Choose which fields future runs record, grouped by type. -->
<script lang="ts">
  import { withUnit } from '../../shared/schema.js'
  import Accordion from '../ui/Accordion.svelte'
  import Switch from '../ui/Switch.svelte'
  import type { Monitored } from './rows.js'

  let {
    types,
    recorded,
    disabled,
    onrecord,
  }: {
    /** The types to list, each with its sampled fields: a label, and each field's label and unit. */
    types: readonly {
      readonly type: string
      readonly label: string
      readonly fields: readonly {
        readonly field: string
        readonly label: string
        readonly unit: string
      }[]
    }[]
    /** What the runs to come record. */
    recorded: Monitored
    disabled: boolean
    /** Record exactly `select` of every element of `type`. */
    onrecord: (type: string, select: readonly string[]) => void
  } = $props()

  /** What the section says for a model with nothing to record. */
  const NOTHING_TO_RECORD = 'This case has no values a run can record.'

  /** The types open now. */
  let expanded = $state<Record<string, boolean>>({})

  /** What a type records, in brief: the labels of its recorded fields, or `none`. */
  function summary(type: (typeof types)[number]): string {
    const on = recorded[type.type] ?? []
    const labels = type.fields.filter(({ field }) => on.includes(field)).map(({ label }) => label)
    return `${labels.length}/${type.fields.length} · ${labels.length === 0 ? 'none' : labels.join(', ')}`
  }

  function toggle(type: string, field: string, on: boolean): void {
    const rest = (recorded[type] ?? []).filter((name) => name !== field)
    onrecord(type, on ? [...rest, field] : rest)
  }
</script>

{#each types as type (type.type)}
  <Accordion
    label={type.label}
    summary={summary(type)}
    data-testid={`monitor-class-${type.type}`}
    bind:open={() => expanded[type.type] === true, (open) => (expanded[type.type] = open)}
  >
    <div class="signal-actions">
      <button
        class="c-btn c-btn--sm"
        {disabled}
        onclick={() =>
          onrecord(
            type.type,
            type.fields.map(({ field }) => field),
          )}
      >
        Select all
      </button>
      <button class="c-btn c-btn--sm" {disabled} onclick={() => onrecord(type.type, [])}>
        Clear
      </button>
    </div>
    {#each type.fields as { field, label, unit } (field)}
      <Switch
        label={withUnit(label, unit)}
        {disabled}
        data-testid={`monitor-${type.type}-${field}`}
        bind:checked={
          () => (recorded[type.type] ?? []).includes(field), (on) => toggle(type.type, field, on)
        }
      />
    {/each}
  </Accordion>
{:else}
  <p class="c-note">{NOTHING_TO_RECORD}</p>
{/each}

<style>
  .signal-actions {
    display: flex;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-lg);
  }
</style>
