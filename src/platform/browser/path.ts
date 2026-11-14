import { URI, Utils } from 'vscode-uri'

const uri = (path: string) =>
  /^[a-z][\w+.-]*:/i.test(path)
    ? URI.parse(path)
    : URI.from({ scheme: 'opfs', path: path.startsWith('/') ? path : '/' + path })
const rendered = (value: URI, original: string) =>
  /^[a-z][\w+.-]*:/i.test(original) ? value.toString() : value.path
export const basename = (path: string) => Utils.basename(uri(path))
export const dirname = (path: string) => rendered(Utils.dirname(uri(path)), path)
export const extname = (path: string) => Utils.extname(uri(path))
export const isAbsolute = (path: string) => path.startsWith('/') || /^[a-z][\w+.-]*:/i.test(path)
export function join(first: string, ...parts: string[]) {
  return rendered(Utils.joinPath(uri(first), ...parts), first)
}
export function resolve(first = '/', ...parts: string[]) {
  let current = first
  for (const part of parts)
    current =
      part.startsWith('/') && /^[a-z][\w+.-]*:/i.test(current)
        ? uri(current).with({ path: part }).toString()
        : isAbsolute(part)
          ? part
          : join(current, part)
  return rendered(Utils.resolvePath(uri(current), '.'), current)
}
export const fileURLToPath = (path: string) => path
