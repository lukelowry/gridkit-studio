declare function acquireVsCodeApi(): { postMessage(message: unknown): void }
const api = acquireVsCodeApi()
const status = document.getElementById('status')!
const save = document.getElementById('save') as HTMLAnchorElement
async function start() {
  const root = await navigator.storage.getDirectory()
  const name = 'gridkit-download-' + crypto.randomUUID()
  const handle = await root.getFileHandle(name, { create: true })
  const writer = await handle.createWritable()
  let url: string | undefined
  let tail = Promise.resolve()
  window.addEventListener(
    'message',
    ({ data }: MessageEvent<{ bytes?: Uint8Array; name?: string }>) => {
      tail = tail
        .then(async () => {
          if (data.bytes) await writer.write(data.bytes as Uint8Array<ArrayBuffer>)
          else if (data.name) {
            await writer.close()
            url = URL.createObjectURL(await handle.getFile())
            save.href = url
            save.download = data.name
            save.textContent = 'Download ' + data.name
            save.hidden = false
            status.textContent = 'Your file is ready.'
            save.click()
          }
          api.postMessage({ ready: true })
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error)
          api.postMessage({ error: status.textContent })
        })
    },
  )
  window.addEventListener('pagehide', () => {
    if (url) URL.revokeObjectURL(url)
    void writer
      .abort()
      .catch(() => {})
      .finally(() => root.removeEntry(name))
  })
  api.postMessage({ ready: true })
}
void start().catch((error: unknown) => {
  status.textContent = error instanceof Error ? error.message : String(error)
  api.postMessage({ error: status.textContent })
})
export {}
