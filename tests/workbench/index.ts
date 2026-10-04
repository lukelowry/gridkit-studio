/** Runs the workbench suites under Mocha, inside the VS Code that holds the extension. */

import Mocha from 'mocha'

import { failed, finish } from './harness.js'

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
      if (this.currentTest?.state === 'failed') await failed(this.currentTest.fullTitle())
    },
    afterAll: finish,
  })
  // A suite registers as its module loads, which is once Mocha listens for it.
  mocha.suite.emit('pre-require', globalThis, 'workbench', mocha)
  await import('./suites.js')
  const failures = await new Promise<number>((resolve) => mocha.run(resolve))
  if (failures) throw new Error(failures + (failures === 1 ? ' test' : ' tests') + ' failed.')
}
