/** The entry for the extension-host suites, run inside the VS Code that holds the extension. */

import { suites } from './mocha.js'
import { extension, failed } from './studio.js'

export const run = () =>
  suites({
    timeout: 30_000,
    load: () => import('./suites.js'),
    async afterEach(test) {
      if (test?.state === 'failed') await failed()
      // What Studio says the user would see fails the test that did not expect it.
      const said = extension().exports.studio.reporter.errors.splice(0)
      if (said.length) throw new Error('GridKit Studio said:\n' + said.join('\n'))
    },
  })
