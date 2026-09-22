# Table data and viewport

The table prepares a query once, then reads projected cells from that immutable view. Scrolling and locating an element do not rebuild the filter/sort intersection.

## Ownership

- The extension host owns case revisions, column metadata, native commands, and persisted preferences.
- One reusable worker serves static tables. A recorded table runs inside its existing CSV worker, beside Results, so both use the same decoded frames.
- Class columns are copied once per binding. Model-owned buffers are never transferred. Newly allocated sparse recording axes are transferred to the worker in the requested display order.
- The webview owns one persistent viewport, keyboard focus, scroll position, and a small cache of aligned pages. It renders only visible rows and columns, with the identity column pinned.

## Query lifetime

A query returns a lease with a row count, committed frame identity, and time. Its read and locate methods always use that snapshot. The caller closes the lease when replacing it. Client-assigned lease IDs allow cleanup even when cancellation races the reply.

Natural order needs only a count. Filtered natural order stores ascending element IDs and uses binary search for selection. Sorted order stores a permutation; dense inverse lookups are built lazily and cached within a separate budget. Sparse or very large sorted selections use a cooperative scan instead of allocating a full inverse.

Concurrent identical queries share their build. Cancelling one caller leaves other readers running; the last cancellation stops the build. Scanning, permutation initialization, and merge sorting yield between batches. Sort ties retain original element order, and missing values stay last.

Static filter membership is reused across frames. A filter already matched by every static row reuses the unfiltered order. Recorded reads only examine rows that static fields did not match. Static sorts remain cached when the timeline advances.

## Playback and focus

The frame queue completes valid work, publishes matching rows, values, and displayed time together, then takes the newest pending frame. A new query or case binding cancels the old queue. Timeline updates do not repeatedly cancel a slow frame. Repeated ticks in the same committed frame reuse the current viewport pages.

Explicit frame identity preserves duplicate timestamps. Queries carry the caller's committed sample count so an append cannot make a captured view observe a later sample.

Showing the table reuses its session. Focus requests carry a monotonically increasing identity, survive loading, and ask the host to focus the native view once the viewport reports readiness. Acknowledgement requires actual document focus. Stale bindings cannot acknowledge a new focus request.

## Memory and work bounds

| Cache                         | Retained budget                   |
| ----------------------------- | --------------------------------- |
| Query row orders              | 64 MiB, up to 8 entries           |
| Dense inverse positions       | 16 MiB, up to 4 entries           |
| Decoded CSV frames per source | 32 MiB, up to 8 frames            |
| Host sample blocks per source | 16 MiB, up to 256 blocks          |
| Webview pages                 | 8 MiB, up to 12 pages of 128 rows |

These are cache budgets, not a total process memory cap: loaded models, open query leases, and active work also consume memory. A decoded frame exceeding the frame budget uses the existing projected decoder rather than retaining an oversized whole-frame allocation. Such extremely wide frames can still require repeated scans.

Physical scroll height is capped at 8 million pixels. Logical row positions map onto that range; wheel and keyboard navigation retain normal row distances. Column widths affect layout and projection without rebuilding the query. Preference writes are debounced in the host; timeline state is separate from metadata.

## Verification and measurement

Run:

```sh
pnpm test
pnpm build
node tests/bench/table.mjs
pnpm test:host
```

The benchmark writes results to output/table-benchmark/results.json. It measures the actual query engine without worker transport or DOM cost: 40-row reads, 8 projected columns, and 15 warm samples reported by median. Browser tests separately cover native focus, keyboard navigation, revision changes, a 10,000-row case with 64 value columns, themes, and recorded data beside the monitor.

Cold full-table searches and dynamic sorts require work proportional to the data size.
