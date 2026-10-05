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
type Proposal = Content & { id: string }
type Status = 'pending' | 'applying' | 'applied' | 'started' | 'discarded' | 'stale' | 'failed'
type Receipt = Revision & {
  action: string
  kind: Content['kind']
  status: Status
  message?: string
  run?: string
}

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

/** Previews that last until they are approved or discarded, or their case changes. Approval
 *  consumes the captured proposal exactly once. */
export class Proposals implements vscode.Disposable {
  readonly #items = new Map<string, Proposal>()
  readonly #receipts = new Map<string, Receipt>()
  readonly #disposables: vscode.Disposable[]
  constructor(
    readonly studio: Sessions,
    readonly tasks: Tasks,
  ) {
    /** The proposal a title-bar button or the palette means: the one on show. */
    const target = (value?: unknown) => {
      const id = shown(value instanceof vscode.Uri ? value : activeResource())
      if (!id) throw new Error('Open the changes or simulation preview first.')
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
      studio.command('gridkitStudio.runAIProposal', (value) => this.approve(target(value))),
      studio.command('gridkitStudio.discardAIProposal', (value) => this.discard(target(value))),
    ]
  }
  prune() {
    for (const [id, item] of this.#items) {
      const entry = this.studio.documents.entries.get(item.uri)
      if (
        !entry ||
        entry.document.isClosed ||
        entry.document.version !== item.version ||
        entry.stale
      )
        this.#finish(id, 'stale')
    }
  }
  #finish(id: string, status: Status, message?: string) {
    this.#items.delete(id)
    const receipt = this.#receipts.get(id)
    if (receipt) Object.assign(receipt, { status, message })
  }
  status(id: string): Record<string, unknown> {
    this.prune()
    const receipt = this.#receipts.get(id)
    return receipt
      ? { ...receipt }
      : {
          action: id,
          status: 'unknown',
          message: 'This action is unknown. Inspect the case and runs before trying again.',
        }
  }
  get(id: string) {
    this.prune()
    const proposal = this.#items.get(id)
    if (!proposal)
      throw new Error(
        'This proposal was applied or discarded, or its case changed. Create a new proposal.',
      )
    return proposal
  }
  #add(proposal: Content) {
    this.prune()
    const item = structuredClone({ ...proposal, id: crypto.randomUUID() })
    this.#items.set(item.id, item)
    this.#receipts.set(item.id, {
      action: item.id,
      kind: item.kind,
      uri: item.uri,
      version: item.version,
      status: 'pending',
    })
    return {
      proposal: item.id,
      action: item.id,
      status: 'pending',
      kind: item.kind,
      revision: { uri: item.uri, version: item.version },
      reviewCommand: 'gridkitStudio.reviewAIProposal',
      instruction:
        item.kind === 'edit'
          ? 'The diff opens in VS Code. Choose Apply changes or Discard in its title bar. Nothing has been applied. Use action_status to check the outcome.'
          : 'The simulation preview opens in VS Code. Choose Run simulation or Discard in its title bar. Nothing has started. Use action_status to check the outcome.',
    }
  }
  edit(revision: Revision, mutations: readonly Mutation[], edits: readonly SourceEdit[]) {
    this.studio.documents.require(revision)
    const document = this.studio.documents.entries.get(revision.uri)!.document
    if (!isWritable(document)) throw new Error('This document is read-only.')
    const before = document.getText()
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
            title: 'Preview AI changes or simulation',
            placeHolder: this.#items.size
              ? 'Choose changes or a simulation to preview'
              : 'No pending changes or simulations',
          },
        )
      )?.id
    if (!id) return
    const proposal = this.get(id)
    const after = vscode.Uri.parse(`${SCHEME}://${id}/${proposal.kind}.json`)
    const title = `${proposal.title} (revision ${proposal.version})`
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
    if ([...this.#receipts.values()].some((receipt) => receipt.status === 'applying'))
      throw new Error('Another AI action is being applied. Wait for it to finish.')
    this.studio.documents.require(proposal)
    this.#finish(id, 'applying')
    try {
      await this.#close(id)
      if (proposal.kind === 'edit') {
        await this.studio.documents.transact(
          proposal.uri,
          proposal.version,
          proposal.mutations,
          'Apply AI changes',
        )
        this.#finish(id, 'applied')
      } else {
        const before = this.studio.all?.get(proposal.uri)?.run?.id
        await this.tasks.run(proposal.uri, proposal.request)
        const run = this.studio.all?.get(proposal.uri)?.run
        if (!run || run.id === before)
          throw new Error('The simulation task ended before a new run started.')
        this.#finish(id, 'started')
        const receipt = this.#receipts.get(id)
        if (receipt) receipt.run = run.id
      }
    } catch (error) {
      this.#finish(id, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  async discard(id: string) {
    this.get(id)
    this.#finish(id, 'discarded')
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
    this.#receipts.clear()
    for (const disposable of this.#disposables) disposable.dispose()
  }
}
