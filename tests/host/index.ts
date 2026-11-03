/** The Mocha entry for the extension-host suites, run inside the VS Code that holds the extension. */

import Mocha from 'mocha'

import { extension, failed } from './studio.js'

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    // Each test waits on what Studio says it did, so a slow one is a fault, not a wait.
    timeout: 30_000,
    // One suite or test by name, such as GRIDKIT_TEST_GREP=Runs; never `.only`, which would let a
    // run pass on the tests it left out.
    grep: process.env.GRIDKIT_TEST_GREP,
    forbidOnly: true,
  })
  mocha.rootHooks({
    async afterEach(this: Mocha.Context) {
      if (this.currentTest?.state === 'failed') await failed()
      // What Studio says the user would see fails the test that did not expect it.
      const said = extension().exports.studio.reporter.errors.splice(0)
      if (said.length) throw new Error('GridKit Studio said:\n' + said.join('\n'))
    },
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
    throw new Error(`Required suites: ${pending} skipped, ${passed} passed.`)
  if (failures) throw new Error(failures + (failures === 1 ? ' test' : ' tests') + ' failed.')
}
