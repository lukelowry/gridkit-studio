import * as vscode from 'vscode'

import type { Mutation, Revision, RunRequest, SourceEdit } from '../shared/messages.js'
import { isWritable } from './documents.js'
import type { Sessions } from './sessions.js'
import type { Tasks } from './tasks.js'

type Content = Revision & {
  title: string
  before: string
  after: string
} & ({ kind: 'edit'; mutations: readonly Mutation[] } | { kind: 'run'; request: RunRequest })
type Proposal = Content & { id: string; expires: number }

/** The scheme of a proposal's preview, `gridkit-proposal://<id>/after.json`. */
const SCHEME = 'gridkit-proposal'

/** The proposal shown at `uri`, if it shows one. */
function shown(uri: vscode.Uri | undefined): string | undefined {
  return uri?.scheme === SCHEME ? uri.authority : undefined
}

/** The resource of the active editor tab: the proposed side of a diff. */
function activeResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputTextDiff
    ? input.modified
    : input instanceof vscode.TabInputText
      ? input.uri
      : undefined
}

/** Short-lived previews. Approval consumes the captured proposal exactly once. */
export class Proposals implements vscode.Disposable {
  readonly #items = new Map<string, Proposal>()
  readonly #disposables: vscode.Disposable[]
  constructor(
    readonly studio: Sessions,
    readonly tasks: Tasks,
  ) {
    /** The proposal a title-bar button or the palette means: the one on show. */
    const target = (value?: unknown) => {
      const id = shown(value instanceof vscode.Uri ? value : activeResource())
      if (!id) throw new Error('Open an AI proposal to review it first.')
      return id
    }
    this.#disposables = [
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: (uri) => {
          const proposal = this.get(uri.authority)
          return uri.path === '/before.json' ? proposal.before : proposal.after
        },
      }),
      studio.documents.changed.event(() => this.prune()),
      studio.command('gridkitStudio.reviewAIProposal', (id) =>
        this.review(typeof id === 'string' ? id : undefined),
      ),
      studio.command('gridkitStudio.approveAIProposal', (value) => this.approve(target(value))),
      studio.command('gridkitStudio.discardAIProposal', (value) => this.discard(target(value))),
    ]
  }
  prune() {
    for (const [id, item] of this.#items) {
      const entry = this.studio.documents.entries.get(item.uri)
      if (
        item.expires < Date.now() ||
        !entry ||
        entry.document.isClosed ||
        entry.document.version !== item.version ||
        entry.stale
      )
        this.#items.delete(id)
    }
  }
  get(id: string) {
    this.prune()
    const proposal = this.#items.get(id)
    if (!proposal)
      throw new Error(
        'This proposal expired, was consumed, or its case changed. Create a new proposal.',
      )
    return proposal
  }
  #add(proposal: Content) {
    this.prune()
    const bytes = Buffer.byteLength(proposal.before) + Buffer.byteLength(proposal.after)
    if (bytes > 4 << 20)
      throw new Error('The review exceeds 4 MiB. Use native editing for this case.')
    while (
      this.#items.size >= 4 ||
      [...this.#items.values()].reduce(
        (n, item) => n + Buffer.byteLength(item.before) + Buffer.byteLength(item.after),
        bytes,
      ) >
        8 << 20
    )
      this.#items.delete(this.#items.keys().next().value!)
    const item = structuredClone({
      ...proposal,
      id: crypto.randomUUID(),
      expires: Date.now() + 10 * 60_000,
    })
    this.#items.set(item.id, item)
    return {
      proposal: item.id,
      kind: item.kind,
      revision: { uri: item.uri, version: item.version },
      expires: item.expires,
      reviewCommand: 'gridkitStudio.reviewAIProposal',
      instruction:
        'Use GridKit Studio: Review AI Proposal in the Command Palette to open the preview, then approve or discard it from its title bar. Nothing has been applied or started.',
    }
  }
  edit(revision: Revision, mutations: readonly Mutation[], edits: readonly SourceEdit[]) {
    this.studio.documents.require(revision)
    const document = this.studio.documents.entries.get(revision.uri)!.document
    if (!isWritable(document)) throw new Error('This document is read-only.')
    const before = document.getText()
    if (Buffer.byteLength(before) > 2 << 20)
      throw new Error(
        'AI edit previews support cases up to 2 MiB. Use native editing for this case.',
      )
    let after = before
    for (const edit of [...edits].sort((a, b) => b.offset - a.offset))
      after = after.slice(0, edit.offset) + edit.text + after.slice(edit.offset + edit.length)
    if (before === after) throw new Error('The proposed edits do not change this case.')
    return this.#add({
      ...revision,
      kind: 'edit',
      title: `Edit ${mutations.length} field${mutations.length === 1 ? '' : 's'}`,
      mutations,
      before,
      after,
    })
  }
  run(request: RunRequest, preview: unknown) {
    this.studio.documents.require(request)
    return this.#add({
      uri: request.uri,
      version: request.version,
      kind: 'run',
      title: 'Run simulation',
      request,
      before: '',
      after: JSON.stringify({ request, preview }, null, 2),
    })
  }
  /** Open proposal `id`'s preview, or one the user picks. Its title bar approves or discards it. */
  async review(id?: string) {
    this.prune()
    if (!id)
      id = (
        await vscode.window.showQuickPick(
          [...this.#items.values()].map((item) => ({
            label: item.title,
            description: item.uri,
            id: item.id,
          })),
          {
            title: 'Review AI Proposal',
            placeHolder: this.#items.size ? 'Choose a proposal to review' : 'No current proposals',
          },
        )
      )?.id
    if (!id) return
    const proposal = this.get(id)
    const after = vscode.Uri.parse(`${SCHEME}://${id}/after.json`)
    const title = `${proposal.title} (AI proposal for revision ${proposal.version})`
    if (proposal.kind === 'edit')
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.parse(`${SCHEME}://${id}/before.json`),
        after,
        title,
        { preview: false },
      )
    else
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(after), {
        preview: false,
      })
  }
  /** Apply proposal `id`'s edits, or start its run, once. */
  async approve(id: string) {
    const proposal = this.get(id)
    this.studio.documents.require(proposal)
    this.#items.delete(id)
    await this.#close(id)
    if (proposal.kind === 'edit')
      await this.studio.documents.transact(
        proposal.uri,
        proposal.version,
        proposal.mutations,
        'Apply AI proposal',
      )
    else await this.tasks.run(proposal.uri, proposal.request)
  }
  async discard(id: string) {
    this.#items.delete(id)
    await this.#close(id)
  }
  /** Close the editors that preview proposal `id`. */
  async #close(id: string) {
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(({ input }) =>
        [
          input instanceof vscode.TabInputTextDiff && input.modified,
          input instanceof vscode.TabInputText && input.uri,
        ].some((uri) => uri && shown(uri) === id),
      )
    if (tabs.length) await vscode.window.tabGroups.close(tabs)
  }
  dispose() {
    this.#items.clear()
    for (const disposable of this.#disposables) disposable.dispose()
  }
}
