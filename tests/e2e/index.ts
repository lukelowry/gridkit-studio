/** The entry for the end-to-end journeys, run inside the VS Code that holds the extension. */

import { suites } from '../host/mocha.js'
import { extension, failed, finish, notifications } from './harness.js'

export const run = () =>
  suites({
    timeout: 60_000,
    load: () => import('./journeys.test.js'),
    async afterEach(test) {
      if (test?.state === 'failed') {
        console.error(test.err?.stack)
        await failed(test.fullTitle())
      }
      // An error the user would see only in the log fails the test, as does a notification; a
      // test that expects one takes it first.
      const logged = extension().exports.studio.reporter.errors.splice(0)
      const shown = await notifications()
      if (logged.length) throw new Error('GridKit Studio logged errors:\n' + logged.join('\n'))
      if (shown.length) throw new Error('VS Code showed notifications:\n' + shown.join('\n'))
    },
    afterAll: finish,
  })
