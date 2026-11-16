/** Target bytes of decoded frames per batch. A wider frame gets a batch of its own. */
export const BATCH_BYTES = 8 << 20

/** Target bytes of decoded frames, across every field, per published chunk. */
export const CHUNK_BYTES = 4 << 20

/** Target bytes of a results file per segment. A segment ends at the first row end past this, or
 *  while a run writes, at the last whole row every PROGRESS_MS. */
export const SEGMENT_BYTES = 4 << 20

/** How often a live run reports progress to the views. */
export const PROGRESS_MS = 100
