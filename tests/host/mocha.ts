/** Mocha inside the VS Code that holds the extension: what the extension-host suites and the
 *  end-to-end journeys run through. */

import Mocha from 'mocha'

interface Suites {
  /** How long a test may take: each waits on what Studio says it did, so a slow one is a fault. */
  readonly timeout: number
  /** Loads the suites, which register as their modules load. */
  load(): Promise<unknown>
  /** What fails a test besides its own asserts, looked at after each. */
  afterEach(test: Mocha.Test | undefined): Promise<void>
  afterAll?(): Promise<void>
}

export async function suites({ timeout, load, afterEach, afterAll }: Suites): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout,
    // One suite or test by name, such as GRIDKIT_TEST_GREP=Runs; never `.only`, which would let a
    // run pass on the tests it left out.
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
