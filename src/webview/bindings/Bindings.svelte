<!-- Map numeric fields to display channels. Mapping a signal also records it in future runs. -->
<script lang="ts">
  import { onMount, tick } from 'svelte'

  import {
    type Channel,
    channelsOf,
    type FieldRef,
    fullNames,
    NUMERIC,
    sameField,
    shortNames,
  } from '../../shared/bindings.js'
  import type { ViewState } from '../../shared/messages.js'
  import { networkOf, typeName } from '../../shared/schema.js'
  import { bridge, merged } from '../bridge.js'
  import { appearance } from '../theme.js'
  import Icon from '../ui/Icon.svelte'
  import Editor from './Editor.svelte'

  /** The two kinds of field every type lists, parameters first: its own data, then what runs record. */
  const KINDS = [
    { id: 'parameters', label: 'Parameters', kind: 'column' },
    { id: 'variables', label: 'Signals', kind: 'signal' },
  ] as const

  /** A field as the panel lists it. */
  interface Listed {
    readonly ref: FieldRef
    readonly kind: 'column' | 'signal'
    readonly label: string
    readonly unit: string
  }

  let view = $state.raw<ViewState>({})
  /** The search over the fields. */
  let query = $state('')
  /** The field the editor is open for, and the channels checked for it, applied only on Apply. */
  let editing = $state.raw<FieldRef | null>(null)
  let checked = $state.raw<readonly Channel[]>([])
  /** What the last Apply did, for a screen reader. */
  let said = $state('')
  /** The field button whose editor is open, which gets focus back when the editor closes. */
  let opener: HTMLButtonElement | null = null

  const bindings = $derived(view.bindings ?? {})
  const needle = $derived(query.trim().toLocaleLowerCase())

  /** The drawn types that have rows, each with its numeric fields of both kinds that match the
   *  search. A type none of whose fields match drops out while a search is on. */
  const owners = $derived.by(() => {
    const summary = view.summary
    if (!summary) return []
    const { vertices, edges } = networkOf(summary.schema)
    const found = []
    for (const type of [...vertices, ...edges.map(({ type }) => type)]) {
      if (!summary.counts[type]) continue
      const label = typeName(summary.schema, type)
      const all: Listed[] = Object.entries(summary.schema.types[type]?.fields ?? {})
        .filter(([, field]) => NUMERIC.has(field.type))
        .map(([field, { sampled, label, unit }]) => ({
          ref: { type, field },
          kind: sampled === true ? 'signal' : 'column',
          label: label ?? field,
          unit: unit ?? '',
        }))
      const groups = KINDS.map((kind) => ({
        ...kind,
        fields: all.filter(
          (field) =>
            field.kind === kind.kind &&
            (needle === '' ||
              [type, label, kind.label, field.label, field.unit]
                .join(' ')
                .toLocaleLowerCase()
                .includes(needle)),
        ),
      }))
      if (needle === '' || groups.some((group) => group.fields.length > 0))
        found.push({ id: type, label, groups })
    }
    return found
  })

  const shown = $derived(
    owners.reduce(
      (sum, owner) => sum + owner.groups.reduce((more, group) => more + group.fields.length, 0),
      0,
    ),
  )

  /** Whether `field` is the one the editor is open for. */
  const isEditing = (field: Listed): boolean => editing !== null && sameField(editing, field.ref)

  /** Whether `owner` lists the field the editor is open for; a search can leave it out, and then the
   *  editor shows nowhere. */
  const listsEditing = (owner: (typeof owners)[number]): boolean =>
    owner.groups.some((group) => group.fields.some(isEditing))

  /** The field the editor is open for, as listed. */
  const edited = $derived(
    owners.flatMap((owner) => owner.groups.flatMap((group) => group.fields)).find(isEditing) ??
      null,
  )

  /** What a field's button says: its tooltip, and its name for assistive technology. */
  function captions(field: Listed, bound: string): { title: string; name: string } {
    const channels = channelsOf(bindings, field.ref)
    const name =
      channels.length > 0
        ? `Edit display bindings for ${field.label}: ${fullNames(channels)}`
        : `Bind ${field.label} to display channels`
    return { title: `${field.label} — ${bound || 'Map to display'}`, name }
  }

  /** Open the editor for `field`, or close it with none; the extension keeps which, so the panel
   *  opens as it was left. */
  function edit(field: FieldRef | null): void {
    editing = field
    checked = field ? channelsOf(bindings, field) : []
    bridge.send({ kind: 'editing', field })
  }

  /** Open the editor for `field` from `button`, or close it when it is open for `field` already. */
  function toggle(field: Listed, button: HTMLButtonElement): void {
    opener = button
    edit(isEditing(field) ? null : field.ref)
  }

  /** Close the editor, and give focus back to the field it was open for. */
  async function closeEditor(): Promise<void> {
    edit(null)
    await tick()
    if (opener?.isConnected) opener.focus()
  }

  /** The editor applied `channels` to `field`. */
  function applied(field: Listed, channels: readonly Channel[]): void {
    said =
      channels.length === 0
        ? `${field.label} display bindings cleared.`
        : `${field.label} bound to ${fullNames(channels)}.`
    editing = null
    checked = []
    void tick().then(() => {
      if (opener?.isConnected) opener.focus()
    })
  }

  onMount(() => {
    const stop = bridge.on((message) => {
      if (message.kind !== 'state') return
      const before = view.editing
      view = merged(view, message.state)
      appearance(view.settings)
      // A field VS Code asked to map opens its editor, as one left open does again.
      const field = view.editing ?? null
      const moved = field ? !sameField(before, field) : before !== undefined
      if (moved && (field ? !sameField(editing ?? undefined, field) : editing !== null)) {
        editing = field
        checked = field ? channelsOf(view.bindings ?? {}, field) : []
      }
    })
    bridge.send({ kind: 'ready' })
    return stop
  })
</script>

{#snippet list(fields: readonly Listed[])}
  <ul class="bindings__list">
    {#each fields as field (field.ref.field)}
      {@const bound = shortNames(channelsOf(bindings, field.ref))}
      {@const open = isEditing(field)}
      {@const { title, name } = captions(field, bound)}
      <li>
        <button
          data-testid={`bindings-link-${field.ref.type}-${field.kind}-${field.ref.field}`}
          class={[
            'bindings__field',
            open && 'bindings__field--editing',
            bound && 'bindings__field--bound',
          ]}
          type="button"
          {title}
          aria-label={name}
          aria-expanded={open}
          aria-controls={open ? `binding-editor-${field.ref.type}` : undefined}
          onclick={(event) => toggle(field, event.currentTarget)}
        >
          <span class="bindings__copy">
            <span class="bindings__label">{field.label}</span>
            {#if bound}
              <span class="bindings__bound">{bound}</span>
            {/if}
          </span>
          <span aria-hidden="true" class="bindings__glyph"><Icon name="link" /></span>
        </button>
      </li>
    {/each}
  </ul>
{/snippet}

<div data-testid="bindings-panel" class="bindings">
  <div class="bindings__search">
    <label for="bindings-search" class="c-sr-only">Search fields</label>
    <input
      data-testid="bindings-search"
      id="bindings-search"
      class="c-input"
      type="search"
      placeholder="Search all fields…"
      bind:value={query}
    />
  </div>

  <div class="bindings__body">
    <p role="status" aria-live="polite" class="c-sr-only">
      {said || `${shown} ${shown === 1 ? 'field' : 'fields'} shown.`}
    </p>

    {#if view.error}
      <p class="c-note c-note--error" role="alert">{view.error}</p>
    {/if}
    {#if shown === 0 && !view.error}
      <div class="c-empty">
        <p class="c-empty__text">
          {!view.summary
            ? 'Loading case…'
            : needle === ''
              ? 'No fields available.'
              : 'No fields match.'}
        </p>
      </div>
    {:else}
      {#each owners as owner (owner.id)}
        {@const heading = `bindings-owner-${owner.id}`}
        <section aria-labelledby={heading} class="bindings__class">
          <h2 id={heading} class="bindings__name">{owner.label}</h2>
          <div class="bindings__kinds">
            {#each owner.groups as group (group.kind)}
              <div
                data-testid={`bindings-${group.id}-${owner.id}`}
                class="bindings__kind"
                role="group"
                aria-label={`${owner.label} ${group.label}`}
              >
                <h3 class="bindings__heading">{group.label}</h3>
                {#if group.fields.length > 0}
                  {@render list(group.fields)}
                {:else}
                  <p class="bindings__none">{needle === '' ? 'None available' : 'No matches'}</p>
                {/if}
              </div>
            {/each}
          </div>
          {#if edited !== null && listsEditing(owner)}
            {@const field = edited}
            <div id={`binding-editor-${owner.id}`} class="bindings__editor">
              <p class="bindings__editing">
                Map <strong>{field.label}</strong>
                <span>
                  {field.kind === 'signal' ? 'Signal' : 'Parameter'}
                </span>
              </p>
              {#key `${field.ref.type}\n${field.ref.field}`}
                <Editor
                  schema={view.summary!.schema}
                  {bindings}
                  field={field.ref}
                  label={field.label}
                  bind:checked
                  close={() => void closeEditor()}
                  save={(channels) => applied(field, channels)}
                />
              {/key}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* The search stays put over a body that scrolls on its own. */
  .bindings {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    container: settings / inline-size;
  }

  .bindings__search {
    flex: 0 0 auto;
    padding: var(--spacing-sm);
    border-block-end: 1px solid var(--color-border);
  }

  .bindings__search .c-input {
    font-family: var(--font-body);
    font-size: var(--text-sm);
  }

  .bindings__body {
    flex: 1;
    min-block-size: 0;
    padding: 0 var(--spacing-sm) var(--spacing-sm);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* One type: its name over its parameters and signals in two columns, and the editor beneath. */
  .bindings__class + .bindings__class {
    margin-block-start: var(--spacing-md);
    border-block-start: 1px solid var(--color-border);
  }

  .bindings__name {
    padding: var(--spacing-sm) var(--spacing-xs);
    color: var(--color-text-1);
    font-size: var(--text-md);
    font-weight: 600;
  }

  .bindings__kinds {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--spacing-sm);
  }

  .bindings__kind {
    min-inline-size: 0;
  }

  .bindings__kind + .bindings__kind {
    padding-inline-start: var(--spacing-sm);
    border-inline-start: 1px solid var(--color-border);
  }

  .bindings__heading {
    padding: 0 var(--spacing-xs) var(--spacing-xs);
    color: var(--color-text-2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .bindings__none {
    padding: var(--spacing-xs);
    color: var(--color-text-3);
    font-size: var(--text-xs);
  }

  /* A field: its label, what it drives in a word or two, and a link glyph, all one button. */
  .bindings__field {
    display: flex;
    gap: var(--spacing-xs);
    align-items: center;
    inline-size: 100%;
    min-block-size: var(--spacing-row-h);
    padding: var(--spacing-xs);
    border-radius: var(--radius-md);
    color: var(--color-text-1);
    text-align: start;
    cursor: pointer;
  }

  .bindings__field:hover {
    background: var(--color-row-hover);
  }

  .bindings__field--editing {
    background: var(--color-selected);
  }

  .bindings__field:focus-visible {
    outline-offset: calc(-1 * var(--focus-width));
  }

  .bindings__copy {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 0 var(--spacing-xs);
    align-items: baseline;
    min-inline-size: 0;
  }

  .bindings__label {
    min-inline-size: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .bindings__bound {
    flex: 0 0 auto;
    margin-inline-start: auto;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .bindings__glyph {
    display: flex;
    flex: 0 0 auto;
    color: var(--color-text-3);
  }

  /* A bound field's summary and glyph take the accent. */
  .bindings__bound,
  .bindings__field--bound .bindings__glyph {
    color: var(--color-primary-text);
  }

  .bindings__editor {
    margin-block-start: var(--spacing-sm);
    border-block-start: 1px solid var(--color-border);
  }

  .bindings__editing {
    display: flex;
    gap: var(--spacing-xs);
    align-items: baseline;
    padding: var(--spacing-sm);
    color: var(--color-text-2);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .bindings__editing strong {
    color: var(--color-text-1);
    font-size: var(--text-sm);
  }

  .bindings__editing span {
    margin-inline-start: auto;
  }

  /* A narrow side bar stacks the two kinds. */
  @container settings (max-width: 15rem) {
    .bindings__kinds {
      grid-template-columns: minmax(0, 1fr);
    }

    .bindings__kind + .bindings__kind {
      padding-inline-start: 0;
      border-inline-start: 0;
    }
  }

  @media (forced-colors: active) {
    .bindings__field--editing {
      outline: 1px solid Highlight;
    }
  }
</style>
