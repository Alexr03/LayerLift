// Loading manifold-3d (WASM) and freeing what it allocates. Every Manifold and CrossSection lives
// on the WASM heap until .delete() is called; a build creates hundreds of intermediates, so all of
// them are tracked while a build runs and freed at the end with `scoped`.
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d'

export type { CrossSection, Manifold, ManifoldToplevel }

interface Deletable {
  delete(): void
}

const stack: Deletable[][] = []

function track(r: unknown) {
  const scope = stack[stack.length - 1]
  if (!scope || r == null) return
  if (Array.isArray(r)) r.forEach(track)
  else if (typeof (r as Deletable).delete === 'function') scope.push(r as Deletable)
}

let patched = false
function patch(w: ManifoldToplevel) {
  if (patched) return
  patched = true
  for (const cls of [w.Manifold, w.CrossSection] as unknown as Record<string, unknown>[]) {
    for (const target of [cls, (cls as unknown as { prototype: Record<string, unknown> }).prototype]) {
      for (const key of Object.getOwnPropertyNames(target)) {
        if (key === 'constructor' || key === 'delete' || key === 'prototype') continue
        const desc = Object.getOwnPropertyDescriptor(target, key)
        if (!desc || typeof desc.value !== 'function' || !desc.writable) continue
        const fn = desc.value as (...a: unknown[]) => unknown
        target[key] = function (this: unknown, ...args: unknown[]) {
          const r = fn.apply(this, args)
          track(r)
          return r
        }
      }
    }
  }
}

let loading: Promise<ManifoldToplevel> | null = null

/** Load the WASM module once. In the browser pass the URL of manifold.wasm. */
export function loadManifold(wasmUrl?: string): Promise<ManifoldToplevel> {
  loading ??= import('manifold-3d').then(async ({ default: Module }) => {
    const w = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined)
    w.setup()
    patch(w)
    return w
  })
  return loading
}

/** Run fn; free every Manifold and CrossSection created meanwhile. Return plain data only. */
export function scoped<T>(fn: () => T): T {
  const scope: Deletable[] = []
  stack.push(scope)
  try {
    return fn()
  } finally {
    stack.pop()
    for (const o of scope) {
      try {
        o.delete()
      } catch {
        /* already freed */
      }
    }
  }
}

/** A CrossSection built with `new` (constructors aren't patched). */
export function crossSection(w: ManifoldToplevel, polys: [number, number][][], fill: 'NonZero' | 'EvenOdd' | 'Positive' = 'Positive'): CrossSection {
  const c = new w.CrossSection(polys, fill)
  track(c)
  return c
}

/** A triangle mesh as plain arrays, ready for three.js or a 3MF file. */
export interface MeshData {
  positions: Float32Array // x, y, z per vertex
  indices: Uint32Array // three per triangle, counter-clockwise seen from outside
}

export function toMesh(m: Manifold): MeshData {
  const mesh = m.getMesh()
  const n = mesh.numProp
  const vp = mesh.vertProperties
  const count = vp.length / n
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = vp[i * n]
    positions[i * 3 + 1] = vp[i * n + 1]
    positions[i * 3 + 2] = vp[i * n + 2]
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) }
}
