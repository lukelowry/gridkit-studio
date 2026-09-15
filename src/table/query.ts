import type { GridSort, GridWindow } from '@latkit/model'

export interface QuerySpec {
  filter: string
  sort: GridSort | null
  time?: number
  frame?: number
  frameCount?: number
}
export interface ViewInfo {
  id: string
  total: number
  frame: number | null
  time?: number
}
/** A view owns one row order and one committed frame until closed. */
export interface TableView extends ViewInfo {
  read(
    offset: number,
    count: number,
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<GridWindow>
  locate(element: number, signal?: AbortSignal): Promise<number | null>
  close(): void
}
export interface Table {
  readonly rowCount: number
  query(spec: QuerySpec, signal?: AbortSignal): Promise<TableView>
  close(): void
}
