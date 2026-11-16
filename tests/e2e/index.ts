/** Entry point for the e2e journeys. */

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
      // Logged errors and notifications fail the test unless the test took them.
      const logged = extension().exports.studio.reporter.errors.splice(0)
      const shown = await notifications()
      if (logged.length) throw new Error('GridKit Studio logged errors:\n' + logged.join('\n'))
      if (shown.length) throw new Error('VS Code showed notifications:\n' + shown.join('\n'))
    },
    afterAll: finish,
  })
