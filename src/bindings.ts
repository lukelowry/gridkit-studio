/** Display channels and defaults adapted from Lattice 8100c24e. */
export const CHANNELS = {
  vertexColor: { label: 'Vertex Color', placement: 'vertex', style: 'color' },
  vertexSize: { label: 'Vertex Size', placement: 'vertex', style: 'size' },
  vertexHeight: { label: 'Vertex Height', placement: 'vertex', style: 'height' },
  edgeColor: { label: 'Edge Color', placement: 'edge', style: 'color' },
  edgeDash: { label: 'Edge Dash', placement: 'edge', style: 'dash' },
} as const
export type Channel = keyof typeof CHANNELS
export interface Binding {
  type: string
  field: string
  domain?: readonly [number, number]
}
export type Bindings = Partial<Record<Channel, Binding>>
export const channelsFor = (placement: 'vertex' | 'edge' | null) =>
  (Object.keys(CHANNELS) as Channel[]).filter((key) => CHANNELS[key].placement === placement)
