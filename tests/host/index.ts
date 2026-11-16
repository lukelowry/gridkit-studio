/** Entry point for the extension-host suites. */

import { suites } from './mocha.js'
import { extension, failed } from './studio.js'

export const run = () =>
  suites({
    timeout: 30_000,
    load: () => import('./suites.js'),
    async afterEach(test) {
      if (test?.state === 'failed') await failed()
      // An error Studio reported fails the test unless the test took it.
      const errors = extension().exports.studio.reporter.errors.splice(0)
      if (errors.length) throw new Error('GridKit Studio reported:\n' + errors.join('\n'))
    },
  })
