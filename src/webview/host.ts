import { randomBytes } from 'node:crypto'

import { bytePort, type Port } from '@latkit/port'
import * as vscode from 'vscode'

export function webviewPort(webview: vscode.Webview): Port {
  return bytePort({
    send: (frame) => {
      void webview
        .postMessage(frame)
        .then(undefined, (error) => console.error('GridKit webview:', error))
    },
    subscribe: (listener) => {
      const off = webview.onDidReceiveMessage(listener)
      return () => off.dispose()
    },
  })
}
export function html(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  surface: 'network' | 'table' | 'monitor' | 'simulation',
  body: string,
): string {
  const root = vscode.Uri.joinPath(extensionUri, 'dist', surface)
  webview.options = { enableScripts: true, localResourceRoots: [root] }
  const nonce = randomBytes(16).toString('hex')
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name))
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; connect-src ${webview.cspSource};">
<link rel="stylesheet" href="${asset('main.css')}"><title>${surface}</title></head>
<body>${body}<script type="module" nonce="${nonce}" src="${asset('main.js')}"></script></body></html>`
}
