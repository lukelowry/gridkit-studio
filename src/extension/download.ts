import * as vscode from 'vscode'

import { nonce } from '../platform/crypto.js'
import { open } from '../platform/files.js'
import { basename } from '../platform/path.js'
import { EXTENSION } from '../shared/ids.js'

/** Downloads a file in a browser host by streaming it in chunks to a webview. Closing the webview
 *  cancels it. */
export async function download(path: string, name = basename(path)): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION)
  if (!extension) throw new Error('GridKit Studio is not installed.')
  const root = vscode.Uri.joinPath(extension.extensionUri, 'dist/webview')
  const panel = vscode.window.createWebviewPanel(
    'gridkitStudio.download',
    'Download ' + name,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] },
  )
  const token = nonce()
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'download.js'))
  let resolve!: () => void
  let reject!: (error: Error) => void
  let waiting = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const messages = panel.webview.onDidReceiveMessage((message: { error?: string }) =>
    message.error ? reject(new Error(message.error)) : resolve(),
  )
  const closed = panel.onDidDispose(() =>
    reject(new DOMException('Download closed.', 'AbortError')),
  )
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}';"><style nonce="${token}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}a{color:var(--vscode-textLink-foreground)}</style></head><body><p id="status">Preparing download…</p><a id="save" hidden>Download</a><script type="module" nonce="${token}" src="${script}"></script></body></html>`
  const send = async (message: unknown) => {
    waiting = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    if (!(await panel.webview.postMessage(message))) reject(new Error('The download view closed.'))
    await waiting
  }
  try {
    await waiting
    const file = await open(path, 'r')
    try {
      const bytes = new Uint8Array(1 << 20)
      for (let at = 0; ;) {
        const { bytesRead } = await file.read(bytes, 0, bytes.length, at)
        if (!bytesRead) break
        await send({ bytes: bytes.subarray(0, bytesRead) })
        at += bytesRead
      }
      await send({ name })
    } finally {
      await file.close()
    }
  } catch (error) {
    panel.dispose()
    throw error
  } finally {
    messages.dispose()
    closed.dispose()
  }
}
