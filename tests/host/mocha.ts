/** Mocha runner inside VS Code for the extension-host suites and the e2e journeys. */

import Mocha from 'mocha'

interface Suites {
  readonly timeout: number
  load(): Promise<unknown>
  /** Extra failure checks run after each test. */
  afterEach(test: Mocha.Test | undefined): Promise<void>
  afterAll?(): Promise<void>
}

export async function suites({ timeout, load, afterEach, afterAll }: Suites): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout,
    // Select tests with GRIDKIT_TEST_GREP=Runs; `.only` is forbidden so a run cannot pass by
    // skipping tests.
    grep: process.env.GRIDKIT_TEST_GREP,
    forbidOnly: true,
  })
  mocha.rootHooks({
    async afterEach(this: Mocha.Context) {
      await afterEach(this.currentTest)
    },
    ...(afterAll && { afterAll }),
  })
  // Suites register as their modules load, so Mocha's globals must exist first.
  mocha.suite.emit('pre-require', globalThis, 'VS Code', mocha)
  await load()
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
