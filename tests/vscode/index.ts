/** The Mocha entry for the VS Code suites, run inside the VS Code that holds the extension. */

import Mocha from 'mocha'

import { extension, failed, finish } from './harness.js'

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60_000,
    // One suite or test by name, such as GRIDKIT_TEST_GREP=Monitor.
    grep: process.env.GRIDKIT_TEST_GREP,
  })
  mocha.rootHooks({
    async afterEach(this: Mocha.Context) {
      if (this.currentTest?.state === 'failed') {
        console.error(this.currentTest.err?.stack)
        await failed(this.currentTest.fullTitle())
      }
      // An error the user would see only in the log fails the test; a test that expects one
      // takes it from `studio.errors` first.
      const logged = extension().exports.studio.errors.splice(0)
      if (logged.length) throw new Error('GridKit Studio logged errors:\n' + logged.join('\n'))
    },
    afterAll: finish,
  })
  // Suites register as their modules load, so Mocha's globals must exist first.
  mocha.suite.emit('pre-require', globalThis, 'VS Code', mocha)
  await import('./suites.js')
  let pending = 0
  let passed = 0
  const failures = await new Promise<number>((resolve) =>
    mocha
      .run(resolve)
      .on('pending', () => pending++)
      .on('pass', () => passed++),
  )
  // A required run allows no skips, so the GridKit suites cannot pass by skipping.
  if (process.env.GRIDKIT_TEST_REQUIRED === '1' && (pending || !passed))
    throw new Error(`Required VS Code suite: ${pending} skipped, ${passed} passed.`)
  if (failures) throw new Error(failures + (failures === 1 ? ' test' : ' tests') + ' failed.')
}
