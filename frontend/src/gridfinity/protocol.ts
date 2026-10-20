// Messages between the page and the geometry worker.
import type { GfFilament, Plate, Scene } from './types'

export type Request =
  | { id: number; kind: 'bin'; scene: Scene; bin: string }
  | { id: number; kind: 'drawer'; scene: Scene }
  | { id: number; kind: 'plate'; scene: Scene }
  | {
      id: number
      kind: 'export'
      title: string
      filaments: GfFilament[]
      plates: Pick<Plate, 'name' | 'drawer' | 'bins'>[]
      bins: string[] | 'all' // which bins; 'all' for every bin on the given plates
      plate: boolean // include the baseplates
      stl: boolean
      forceZip?: boolean
      version?: string
    }

/** A coloured mesh in the preview; `group` is the bin id, or "plate-<n>" for a baseplate piece. */
export interface ViewPart {
  group: string
  name: string
  hex: string
  filament: number
  positions: Float32Array
  indices: Uint32Array
}

export type Response =
  | { id: number; kind: 'parts'; parts: ViewPart[]; volume: number }
  | { id: number; kind: 'file'; name: string; data: Uint8Array }
  | { id: number; kind: 'error'; message: string }

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never
export type RequestBody = Distribute<Request>
