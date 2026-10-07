/** How many bytes of decoded frames one batch aims for; a wider frame is a batch of its own. */
export const BATCH_BYTES = 8 << 20

/** How many bytes of a results file one page aims for: it ends at the first row end past them. A
 *  live run's pages end sooner, at the rows GridKit has written each time the views look. */
export const PAGE_BYTES = 4 << 20

/** How often a live run tells the views of its progress, and so how often they take its pages. */
export const PROGRESS_MS = 100
