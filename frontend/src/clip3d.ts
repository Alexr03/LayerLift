// The layer slider's cut. Every part is clipped by one horizontal plane, and the cut is capped
// with a flat face in a darker shade of the part's colour, like a sliced layer. The cap is the
// usual stencil trick: a part's back faces add to the stencil and its front faces subtract, so
// only pixels inside that part's cut are left non-zero, and a plane drawn at the cut height fills
// exactly those pixels. Renderers must be created with `stencil: true`.
import * as THREE from 'three'

export const NO_CUT = 1e6

export function cutPlane(): THREE.Plane {
  // Keeps everything at or below z = constant.
  return new THREE.Plane(new THREE.Vector3(0, 0, -1), NO_CUT)
}

/**
 * A filament colour as the preview shows it. Like a slicer, very dark filament is shown as dark
 * grey so it reads against the graphite plate; the real colour still goes in the file.
 */
export function displayColour(hex: string): THREE.Color {
  const c = new THREE.Color(hex)
  // Lightness as the eye sees it (sRGB), not three's linear working space: in linear terms a
  // mid blue like #1446AA looks "dark" and would be lifted and greyed.
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl, THREE.SRGBColorSpace)
  if (hsl.l < 0.22) c.setHSL(hsl.h, hsl.s * 0.6, 0.22, THREE.SRGBColorSpace)
  return c
}

/** Crisp feature edges, so faces of one colour stay legible (bins, baseplates). */
export function addEdges(mesh: THREE.Mesh, plane: THREE.Plane) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 28)
  const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, clippingPlanes: [plane] }))
  lines.raycast = () => undefined
  mesh.add(lines)
}

const noPick = () => undefined

function stencilPass(side: THREE.Side, op: THREE.StencilOp, plane: THREE.Plane) {
  return new THREE.MeshBasicMaterial({
    side,
    clippingPlanes: [plane],
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  })
}

/** Section caps for a set of parts; `cut(z)` moves them to a height, `cut(null)` hides them. */
export function addSections(parts: THREE.Mesh[], plane: THREE.Plane, parent: THREE.Object3D): { cut: (z: number | null) => void; dispose: () => void } {
  const caps: THREE.Mesh[] = []
  parts.forEach((part, i) => {
    const mat = part.material as THREE.MeshLambertMaterial
    mat.clippingPlanes = [plane]
    const order = 10 + i * 3
    const back = new THREE.Mesh(part.geometry, stencilPass(THREE.BackSide, THREE.IncrementWrapStencilOp, plane))
    const front = new THREE.Mesh(part.geometry, stencilPass(THREE.FrontSide, THREE.DecrementWrapStencilOp, plane))
    back.renderOrder = order
    front.renderOrder = order
    back.raycast = noPick
    front.raycast = noPick
    part.add(back, front) // children, so they follow the part when it moves
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: mat.color.clone().multiplyScalar(0.72),
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      }),
    )
    cap.renderOrder = order + 1
    cap.visible = false
    cap.raycast = noPick
    cap.onAfterRender = (renderer) => renderer.clearStencil()
    caps.push(cap)
    parent.add(cap)
  })
  return {
    cut(z) {
      const box = new THREE.Box3()
      for (const p of parts) box.expandByObject(p)
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      for (const cap of caps) {
        cap.visible = z != null
        cap.scale.set(size.x * 1.2 + 1, size.y * 1.2 + 1, 1)
        cap.position.set(centre.x, centre.y, z ?? 0)
      }
    },
    dispose() {
      for (const cap of caps) {
        parent.remove(cap)
        cap.geometry.dispose()
        ;(cap.material as THREE.Material).dispose()
      }
    },
  }
}
