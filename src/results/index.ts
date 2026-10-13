/** GridKit results files: its CSV, decoded once into a store of Studio's own, read in chunks of
 *  frames. */

export { ResultCache } from './cache.js'
export { closed, type Reading, ResultsFile } from './file.js'
export type { Writer } from './follow.js'
export { PROGRESS_MS } from './limits.js'
export { type Stamp, stampAt, stampOf } from './stamp.js'
export { fileKey, type Store, Stores } from './store.js'
