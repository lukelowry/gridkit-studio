import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
export const browserPlatform = {
  name: 'browser-platform',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, ({ path, importer }) => {
      const target = resolve(dirname(importer), path)
      const relative = target.slice(root.length).replaceAll('\\', '/')
      const match =
        /^src\/(?:platform\/(files|path|host|thread|timing|worker|solver)|gridkit\/(runtime))\.js$/.exec(
          relative,
        )
      if (match)
        return { path: resolve(root, 'src/platform/browser', (match[1] ?? match[2]) + '.ts') }
    })
  },
}
