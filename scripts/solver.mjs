/** Fetch once at build time. The VSIX contains everything needed to run offline. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { x } from 'tar'

const root = fileURLToPath(new URL('../', import.meta.url))
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function checked(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`GridKit download failed (${response.status}): ${url}`)
  return response
}
export async function copySolver(destination) {
  const manifest = JSON.parse(await readFile(resolve(root, 'scripts/solver.lock.json'), 'utf8'))
  const { repository, sha256 } = manifest.download
  const cache = resolve(root, 'node_modules/.cache/gridkit')
  const archive = resolve(cache, `${sha256}.tar.gz`)
  let bytes = await readFile(archive).catch(() => undefined)
  if (!bytes || checksum(bytes) !== sha256) {
    const { token } = await (
      await checked(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`)
    ).json()
    bytes = Buffer.from(
      await (
        await checked(`https://ghcr.io/v2/${repository}/blobs/sha256:${sha256}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).arrayBuffer(),
    )
    if (checksum(bytes) !== sha256) throw new Error('GridKit archive checksum mismatch.')
    await mkdir(cache, { recursive: true })
    const temporary = `${archive}.${process.pid}.tmp`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, archive)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  await mkdir(destination, { recursive: true })
  await x({
    file: archive,
    cwd: destination,
    strict: true,
    filter: (name, entry) =>
      ['File', 'Directory'].includes(entry.type) &&
      !name.split('/').includes('..') &&
      (Object.hasOwn(manifest.files, name) || /^licenses\/[\w./-]+$/.test(name)),
  })
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (checksum(await readFile(resolve(destination, name))) !== expected)
      throw new Error(`GridKit checksum mismatch: ${name}`)
  }
  await writeFile(resolve(destination, 'build.json'), JSON.stringify(manifest, null, 2) + '\n')
}
