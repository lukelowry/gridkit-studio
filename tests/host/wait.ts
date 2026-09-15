import type { Locator } from 'playwright-core'

export async function until<T>(
  read: () => T | PromiseLike<T>,
  ready: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < end)
  throw new Error('Timed out waiting for test state')
}

export async function focus(target: Locator): Promise<void> {
  await target.focus()
  await until(() => target.evaluate((element) => element.ownerDocument.hasFocus()), Boolean)
}
