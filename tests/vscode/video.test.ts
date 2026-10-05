/** Video files: an export replaces its destination only once it completes. */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { setup, suite, teardown, test } from 'mocha'
import * as vscode from 'vscode'

import { VideoFile } from '../../src/extension/video.js'
import { folder } from './harness.js'

suite('Video files', () => {
  let directory: string
  let destination: vscode.Uri
  let file: VideoFile | undefined
  const bytes = (value: string) => new TextEncoder().encode(value)

  setup(async () => {
    directory = await mkdtemp(join(folder().fsPath, 'video-'))
    destination = vscode.Uri.file(join(directory, 'results.mp4'))
    file = undefined
  })
  teardown(async () => {
    await file?.abort()
    await rm(directory, { recursive: true, force: true })
  })

  test('cancelling an overwrite preserves the original video', async () => {
    await writeFile(destination.fsPath, 'original')
    file = await VideoFile.create(destination)
    await file.write(0, bytes('unfinished'))
    assert.equal(await readFile(destination.fsPath, 'utf8'), 'original')
    await file.abort()
    assert.equal(await readFile(destination.fsPath, 'utf8'), 'original')
    assert.deepEqual(await readdir(directory), ['results.mp4'])
  })

  test('publishes positional writes only after successful completion', async () => {
    await writeFile(destination.fsPath, 'original')
    file = await VideoFile.create(destination)
    await file.write(6, bytes('world'))
    await file.write(0, bytes('hello '))
    await file.close()
    await file.abort()
    assert.equal(await readFile(destination.fsPath, 'utf8'), 'hello world')
    assert.deepEqual(await readdir(directory), ['results.mp4'])
    await assert.rejects(file.write(0, bytes('late')), /closed/)
  })

  test('a failed replacement leaves the destination intact and can be cleaned up', async () => {
    file = await VideoFile.create(destination)
    await file.write(0, bytes('new video'))
    await mkdir(destination.fsPath)
    await writeFile(join(destination.fsPath, 'keep.txt'), 'original')
    await assert.rejects(file.close())
    await file.abort()
    assert.equal(await readFile(join(destination.fsPath, 'keep.txt'), 'utf8'), 'original')
    assert.deepEqual(await readdir(directory), ['results.mp4'])
  })
})
