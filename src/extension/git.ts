import * as vscode from 'vscode'

// Minimal boundary of the built-in Git extension's versioned public API.
interface GitApi {
  getRepository(uri: vscode.Uri): { rootUri: vscode.Uri } | null
  getRepositoryRoot(uri: vscode.Uri): Promise<vscode.Uri | null>
  openRepository(root: vscode.Uri): Promise<unknown>
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri
}
export async function reviewChanges(uri: vscode.Uri) {
  const extension = vscode.extensions.getExtension<{
    enabled: boolean
    getAPI(version: 1): GitApi
  }>('vscode.git')
  const git = await extension?.activate()
  if (!git?.enabled) throw new Error('Enable the built-in Git extension to review case changes.')
  const api = git.getAPI(1)
  if (!api.getRepository(uri)) {
    const root = await api.getRepositoryRoot(vscode.Uri.joinPath(uri, '..'))
    if (!root) throw new Error('This case is not in a Git repository.')
    await api.openRepository(root)
  }
  const base = api.toGitUri(uri, 'HEAD')
  try {
    await vscode.workspace.openTextDocument(base)
  } catch {
    throw new Error('This case has no committed version yet. Use Source Control to add it.')
  }
  // The right side is the existing TextDocument, including unsaved diagram edits.
  await vscode.commands.executeCommand(
    'vscode.diff',
    base,
    uri,
    uri.path.split('/').at(-1) + ' (Working changes)',
    { preview: false },
  )
}
