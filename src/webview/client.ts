import { bytePort } from '@latkit/port'
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}
export const vscode = acquireVsCodeApi()
export const port = bytePort({
  send: (frame) => vscode.postMessage(frame),
  subscribe(listener) {
    const receive = (event: MessageEvent) => listener(event.data)
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  },
})
