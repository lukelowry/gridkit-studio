<!-- Stage a field's channel assignments until Apply. Cancel and Escape leave mappings unchanged. -->
<script lang="ts">
  import type { Schema } from '@latkit/model'

  import {
    type Bindings,
    type Channel,
    CHANNELS,
    channelsFor,
    type FieldRef,
    sameField,
  } from '../../shared/bindings.js'
  import { networkOf, placementOf } from '../../shared/schema.js'
  import { bridge } from '../bridge.js'

  let {
    schema,
    bindings,
    field,
    label,
    checked = $bindable(),
    close,
    save,
  }: {
    schema: Schema
    bindings: Bindings
    /** The field whose mappings are edited. */
    field: FieldRef
    /** The field's name. */
    label: string
    /** The channels checked for it, applied only on Apply. */
    checked: readonly Channel[]
    /** Leave the editor without applying. */
    close: () => void
    /** The checked channels were applied. */
    save: (channels: readonly Channel[]) => void
  } = $props()

  const id = $props.id()
  /** The channels the field could drive, each with whoever drives it now. */
  const options = $derived(
    channelsFor(placementOf(networkOf(schema), field.type)).map((channel) => {
      const source = bindings[channel]
      const owned = sameField(source, field)
      return {
        channel,
        label: CHANNELS[channel].label,
        owned,
        owner: owned || source === undefined ? null : source,
      }
    }),
  )
  /** The values the reader set the field's channels to span; none for the measured ones. */
  const rangeOf = () => Object.values(bindings).find((binding) => sameField(binding, field))?.domain
  /** The range the editor opens on, and the two ends as the reader types them. */
  const opened = rangeOf()
  let low = $state(opened ? String(opened[0]) : '')
  let high = $state(opened ? String(opened[1]) : '')
  let failure = $state<string | null>(null)

  /** The name of the field `ref` is. */
  function nameOf(ref: FieldRef): string {
    return schema.types[ref.type]?.fields[ref.field]?.label ?? ref.field
  }

  /** Focus the first channel as the editor opens, and let Escape inside it cancel. */
  function arm(form: HTMLFormElement): () => void {
    form.querySelector('input')?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    form.addEventListener('keydown', keydown)
    return () => form.removeEventListener('keydown', keydown)
  }

  function check(channel: Channel, on: boolean): void {
    const others = checked.filter((candidate) => candidate !== channel)
    checked = on ? [...others, channel] : others
  }

  function apply(): void {
    failure = null
    const bounds = [low, high].map((text) => (text.trim() === '' ? null : Number(text)))
    const [from, to] = bounds
    const ranged = from !== null && to !== null
    if ((from === null) !== (to === null) || (ranged && !(from! < to!))) {
      failure = 'Enter two increasing bounds, or leave both empty to measure the range.'
      return
    }
    bridge.send({
      kind: 'bind',
      field: { type: field.type, field: field.field },
      channels: [...checked],
      ...(ranged && { domain: [from!, to!] as const }),
    })
    save(checked)
  }
</script>

<form
  class="binding-editor"
  data-testid="binding-editor"
  aria-label={`Display bindings for ${label}`}
  {@attach arm}
  onsubmit={(event) => {
    event.preventDefault()
    apply()
  }}
>
  <fieldset class="binding-editor__channels">
    <legend class="c-sr-only">Display channels</legend>
    <div class="binding-editor__head" aria-hidden="true">
      <span>Channel</span>
    </div>
    {#each options as { channel, label: name, owned, owner } (channel)}
      {@const on = checked.includes(channel)}
      {@const holder = owned ? label : owner === null ? null : nameOf(owner)}
      {@const taking = owner !== null && on}
      {@const dropping = owned && !on}
      {@const status = taking
        ? `Replaces ${holder}`
        : dropping
          ? `Removes ${label}`
          : holder
            ? `Mapped to ${holder}`
            : ''}
      <div class={['bindings__choice', on && 'bindings__choice--selected']}>
        <label class="binding-editor__control">
          <input
            type="checkbox"
            value={channel}
            checked={on}
            data-testid={`binding-${channel}`}
            aria-label={name}
            aria-describedby={holder ? `${id}-status-${channel}` : undefined}
            onchange={(event) => check(channel, event.currentTarget.checked)}
          />
          <span class="binding-editor__label">{name}</span>
        </label>
        <span
          class={[
            'binding-editor__status',
            (taking || dropping) && 'binding-editor__status--changing',
          ]}
          title={status}
        >
          <span id={`${id}-status-${channel}`} class="c-sr-only">{status}</span>
          {#if taking}
            <span class="binding-editor__verb" aria-hidden="true">Replace</span>
          {:else if dropping}
            <span class="binding-editor__verb" aria-hidden="true">Remove</span>
          {/if}
          <span class="bindings__owner" aria-hidden="true">{holder ?? ''}</span>
        </span>
      </div>
    {/each}
  </fieldset>

  <div class="binding-editor__range" role="group" aria-label="Value range">
    <span class="binding-editor__caption">Range</span>
    <span class="c-field">
      <input
        type="number"
        step="any"
        placeholder="Auto"
        aria-label="Lowest value"
        bind:value={low}
      />
    </span>
    <span class="c-field">
      <input
        type="number"
        step="any"
        placeholder="Auto"
        aria-label="Highest value"
        bind:value={high}
      />
    </span>
  </div>

  {#if failure}<p class="c-note c-note--error" role="alert">{failure}</p>{/if}

  <div class="binding-editor__actions">
    <button class="c-btn" type="button" onclick={close}>Cancel</button>
    <button data-testid="binding-apply" class="c-btn c-btn--primary" type="submit">Apply</button>
  </div>
</form>

<style>
  .binding-editor {
    margin-block-end: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-sm);
    border-block-end: 1px solid var(--color-border);
  }

  .binding-editor__channels {
    min-inline-size: 0;
  }

  .binding-editor__head,
  .binding-editor__caption {
    padding: var(--spacing-xs) var(--spacing-sm);
    color: var(--color-text-2);
    font-size: var(--text-xs);
  }

  /* One channel: its checkbox and name on the left, who drives it (and what Apply changes) on the
     right. The row tints while checked and rings while its checkbox has keyboard focus. */
  .bindings__choice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--spacing-sm);
    align-items: center;
    min-block-size: var(--spacing-row-h);
    padding-inline: var(--spacing-sm);
    border-radius: var(--radius-md);
  }

  .bindings__choice:has(.binding-editor__control:hover) {
    background: var(--color-row-hover);
  }

  .bindings__choice--selected {
    background: var(--color-selected);
  }

  .bindings__choice:has(input:focus-visible) {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-width));
  }

  .bindings__choice input {
    flex: 0 0 auto;
    inline-size: var(--spacing-md);
    block-size: var(--spacing-md);
    accent-color: var(--color-primary);
    outline: none;
  }

  .binding-editor__control {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    min-block-size: var(--spacing-row-h);
    cursor: pointer;
  }

  .binding-editor__label {
    color: var(--color-text-1);
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .binding-editor__status {
    display: flex;
    gap: var(--spacing-xs);
    align-items: center;
    justify-content: flex-end;
    min-inline-size: 0;
    color: var(--color-text-2);
    font-size: var(--text-xs);
  }

  /* A status that Apply would change reads in the warning color. */
  .binding-editor__status--changing {
    color: var(--color-warning-text);
  }

  .binding-editor__verb {
    flex: 0 0 auto;
  }

  .bindings__owner {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* The values the channels span: both ends, or neither for the measured range. */
  .binding-editor__range {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--spacing-xs);
    align-items: center;
    padding-block-start: var(--spacing-xs);
    padding-inline-end: var(--spacing-sm);
  }

  .binding-editor__actions {
    display: flex;
    gap: var(--spacing-xs);
    justify-content: flex-end;
    padding-block-start: var(--spacing-sm);
  }

  @media (forced-colors: active) {
    .bindings__choice:has(input:focus-visible) {
      outline-color: Highlight;
    }
  }
</style>
