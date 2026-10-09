/** How many bytes of decoded frames one batch aims for; a wider frame is a batch of its own. */
export const BATCH_BYTES = 8 << 20

/** How many bytes of decoded frames, of every field a file holds, one chunk aims for. A chunk is
 *  what a view asks for at once, and what the worker's cache keeps. */
export const CHUNK_BYTES = 4 << 20

/** How many bytes of a results file one segment aims for: it ends at the first row end past them.
 *  While a run writes, one also ends at the last whole row read each time the views hear of it. */
export const SEGMENT_BYTES = 4 << 20

/** How often a live run tells the views of its progress. */
export const PROGRESS_MS = 100
