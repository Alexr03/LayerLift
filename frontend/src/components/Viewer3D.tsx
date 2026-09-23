import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fmt } from '../palettes'

/** Raise or lower a colour by dragging it on the model (the editor's 3D view only). */
export interface HeightEdit {
  parts: { filament: number; name: string; hex: string }[]
  built: Record<number, number> // each filament's top in the loaded model (result.filament_heights)
  current: Record<number, number> // each filament's top in the current settings: what the model shows
  stacked: boolean // stacked bands: raising one lifts the bands above it too
  layer: number
  min: Record<number, number> // lowest top each filament may have
  active: number | null
  onActive: (filament: number | null) => void
  onCommit: (tops: Record<number, number>) => void // the filaments whose top changed, in mm
  disabled?: string // why dragging is off, e.g. under the compact strategy
}

interface Props {
  url: string
  explode: number // 0..1, lifts each part apart to show the layering
  edit?: HeightEdit
}

const MAX_TOP = 50
const EPS = 1e-3
// Drag distance per print layer. Fixed rather than tied to the camera: seen from above, height
// barely moves on screen, which would make every pixel several millimetres.
const PX_PER_LAYER = 16

/** Filaments bottom to top by their built height (the stacked strategy's band order). */
function bandOrder(edit: HeightEdit): number[] {
  return edit.parts.map((p) => p.filament).sort((a, b) => edit.built[a] - edit.built[b] || a - b)
}

export default function Viewer3D({ url, explode, edit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const partsRef = useRef<THREE.Mesh[]>([])
  const renderRef = useRef<() => void>(() => {})
  const applyRef = useRef<(tops: Record<number, number>) => void>(() => {})
  const editRef = useRef(edit)
  editRef.current = edit
  const draggingRef = useRef(false)
  const [loaded, setLoaded] = useState(0)
  const [drag, setDrag] = useState<{ x: number; y: number; label: string } | null>(null)

  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000)
    camera.up.set(0, 0, 1) // the model is Z-up millimetres
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) // transparent: the work surface shows through
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    const canvas = renderer.domElement
    mount.appendChild(canvas)

    scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 1.1))
    const key = new THREE.DirectionalLight('#ffffff', 1.8)
    key.position.set(-80, -120, 200)
    scene.add(key)
    const rim = new THREE.DirectionalLight('#ffffff', 0.6)
    rim.position.set(120, 150, 80)
    scene.add(rim)

    const render = () => renderer.render(scene, camera)
    renderRef.current = render

    // ------------------------------------------------------------ height preview
    // Every part keeps its built z values; a preview maps each filament's built top (and, for
    // stacked bands, its bottom) onto the height it should show now. Parts are prisms, so those
    // are the only z values that move; walls stretch with them.
    applyRef.current = (tops) => {
      const e = editRef.current
      if (!e) return
      const order = e.stacked ? bandOrder(e) : []
      for (const mesh of partsRef.current) {
        const f = mesh.userData.filament as number
        const orig = mesh.userData.origZ as Float32Array | undefined
        if (orig === undefined || e.built[f] === undefined) continue
        const builtTop = e.built[f]
        const top = tops[f] ?? builtTop
        let builtBottom = Number.NaN
        let bottom = Number.NaN
        const i = order.indexOf(f)
        if (i > 0) {
          builtBottom = e.built[order[i - 1]]
          bottom = tops[order[i - 1]] ?? builtBottom
        }
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
        for (let k = 0; k < orig.length; k++) {
          const z0 = orig[k]
          pos.setZ(k, Math.abs(z0 - builtTop) < EPS ? top : Math.abs(z0 - builtBottom) < EPS ? bottom : z0)
        }
        pos.needsUpdate = true
        mesh.geometry.computeBoundingBox()
        mesh.geometry.computeBoundingSphere()
      }
      render()
    }

    // ------------------------------------------------------------ picking and dragging
    const raycaster = new THREE.Raycaster()
    const pick = (ev: PointerEvent): { filament: number } | null => {
      const r = canvas.getBoundingClientRect()
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObjects(partsRef.current, false)[0]
      return hit ? { filament: hit.object.userData.filament as number } : null
    }
    let session: { filament: number; startY: number; startTop: number; target: Record<number, number> } | null = null
    let press: { x: number; y: number; filament: number | null } | null = null

    const targetFor = (e: HeightEdit, fil: number, want: number): Record<number, number> => {
      const snap = (z: number) => Math.round(z / e.layer) * e.layer
      if (!e.stacked) {
        const top = Math.min(MAX_TOP, Math.max(e.min[fil] ?? e.layer, snap(want)))
        return { ...e.current, [fil]: +top.toFixed(4) }
      }
      // Stacked: the band keeps at least a layer above the one below, and the bands above keep
      // their thickness, so they move by the same amount.
      const order = bandOrder(e)
      const i = order.indexOf(fil)
      const floor = i > 0 ? e.current[order[i - 1]] + e.layer : (e.min[fil] ?? e.layer)
      const highest = Math.max(...order.map((f) => e.current[f]))
      let delta = snap(Math.max(floor, want)) - e.current[fil]
      delta = Math.min(delta, MAX_TOP - highest)
      const out = { ...e.current }
      for (const f of order.slice(i)) out[f] = +(e.current[f] + delta).toFixed(4)
      return out
    }

    const onDown = (ev: PointerEvent) => {
      const e = editRef.current
      if (!e || ev.button !== 0) return
      const hit = pick(ev)
      if (!e.disabled && hit && hit.filament === e.active) {
        // Drag this colour instead of orbiting.
        ev.stopImmediatePropagation()
        controls.enabled = false
        canvas.setPointerCapture(ev.pointerId)
        draggingRef.current = true
        session = { filament: hit.filament, startY: ev.clientY, startTop: e.current[hit.filament], target: e.current }
        return
      }
      press = { x: ev.clientX, y: ev.clientY, filament: hit?.filament ?? null }
    }
    const onMove = (ev: PointerEvent) => {
      const e = editRef.current
      if (session && e) {
        const want = session.startTop + ((session.startY - ev.clientY) / PX_PER_LAYER) * e.layer
        session.target = targetFor(e, session.filament, want)
        applyRef.current(session.target)
        const r = mount.getBoundingClientRect()
        const name = e.parts.find((p) => p.filament === session!.filament)?.name ?? ''
        setDrag({ x: ev.clientX - r.left, y: ev.clientY - r.top, label: `${name} · ${fmt(session.target[session.filament])} mm` })
        return
      }
      if (!e || ev.buttons) return
      const hit = pick(ev)
      canvas.style.cursor = !hit ? '' : !e.disabled && hit.filament === e.active ? 'ns-resize' : 'pointer'
    }
    const onUp = (ev: PointerEvent) => {
      const e = editRef.current
      if (session && e) {
        const changed: Record<number, number> = {}
        for (const [f, top] of Object.entries(session.target)) if (Math.abs(top - e.current[+f]) > EPS) changed[+f] = top
        session = null
        draggingRef.current = false
        controls.enabled = true
        if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
        setDrag(null)
        if (Object.keys(changed).length) e.onCommit(changed)
        else applyRef.current(e.current)
        return
      }
      // A click (not an orbit) on a colour picks it.
      if (press && e && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 5 && press.filament !== null) e.onActive(press.filament)
      press = null
    }
    canvas.addEventListener('pointerdown', onDown, { capture: true })
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      if (controls.update()) render()
    }
    controls.addEventListener('change', render)

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
      render()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let disposed = false
    new GLTFLoader().load(url, (gltf) => {
      if (disposed) return
      // The exporter writes raw Z-up millimetres and the camera is Z-up, so no rotation is needed.
      const root = gltf.scene
      scene.add(root)
      root.updateMatrixWorld(true)
      const parts: THREE.Mesh[] = []
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh
          const mat = mesh.material as THREE.MeshStandardMaterial
          mat.flatShading = true
          mat.needsUpdate = true
          parts.push(mesh)
          mesh.userData.baseZ = mesh.position.z
          // Parts are named part_<filament> by the exporter (the node, or the mesh itself).
          const name = `${mesh.name} ${mesh.parent?.name ?? ''}`
          const m = name.match(/part_(\d+)/)
          mesh.userData.filament = m ? Number(m[1]) : -1
          const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
          const z = new Float32Array(pos.count)
          for (let k = 0; k < pos.count; k++) z[k] = pos.getZ(k)
          mesh.userData.origZ = z
        }
      })
      partsRef.current = parts
      const box = new THREE.Box3().setFromObject(root)
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      // Back off further on narrow (portrait) viewports so the whole width stays in frame.
      const r = (Math.max(size.x, size.y) * 1.25) / Math.min(1, camera.aspect)
      camera.position.set(centre.x - r * 0.35, centre.y - r * 1.3, centre.z + r * 1.1)
      controls.target.copy(centre)
      controls.update()
      setLoaded((n) => n + 1)
      render()
    })
    tick()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      canvas.removeEventListener('pointerdown', onDown, { capture: true })
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry.dispose()
          ;(m.material as THREE.Material).dispose()
        }
      })
      mount.removeChild(canvas)
    }
  }, [url])

  useEffect(() => {
    // Parts are stored in the order of the filament list; lift each one a little more.
    partsRef.current.forEach((p, i) => {
      p.position.z = (p.userData.baseZ ?? 0) + explode * 6 * i
    })
    renderRef.current()
  }, [explode])

  // Show the settings' heights: after a drag, a typed height, or an undo. Not mid-drag.
  const currentKey = edit ? JSON.stringify(edit.current) : ''
  useEffect(() => {
    if (edit && !edit.disabled && !draggingRef.current) applyRef.current(edit.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, loaded, edit?.disabled])

  // Tint the colour being edited so it's clear what a drag will move.
  const active = edit?.disabled ? null : (edit?.active ?? null)
  useEffect(() => {
    for (const mesh of partsRef.current) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.emissive.set(mesh.userData.filament === active ? '#1c1f24' : '#000000')
    }
    renderRef.current()
  }, [active, loaded])

  return (
    <div className="viewer" ref={mountRef} aria-label="3D preview. Drag to orbit, scroll to zoom.">
      {edit && (
        <div className="height-tool" role="toolbar" aria-label="Raise or lower a colour">
          <div className="height-swatches">
            {edit.parts.map((p) => (
              <button
                key={p.filament}
                type="button"
                className={edit.active === p.filament ? 'swatch on' : 'swatch'}
                style={{ background: p.hex }}
                aria-pressed={edit.active === p.filament}
                disabled={!!edit.disabled}
                title={`${p.name}: ${fmt(edit.current[p.filament] ?? 0)} mm`}
                onClick={() => edit.onActive(edit.active === p.filament ? null : p.filament)}
              />
            ))}
          </div>
          <span className="height-hint">
            {edit.disabled
              ? edit.disabled
              : edit.active === null
                ? 'Pick a colour (or click one on the model), then drag it up or down.'
                : `Drag ${edit.parts.find((p) => p.filament === edit.active)?.name ?? 'it'} up or down on the model · ${fmt(edit.current[edit.active] ?? 0)} mm`}
          </span>
        </div>
      )}
      {drag && (
        <div className="drag-label" style={{ left: drag.x, top: drag.y }}>
          {drag.label}
        </div>
      )}
    </div>
  )
}
