import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { lightScene } from '../../lighting'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ViewPart } from '../../gridfinity/protocol'
import { NO_CUT, addEdges, addSections, cutPlane, displayColour } from '../../clip3d'

interface Props {
  parts: ViewPart[]
  fitKey: string // when this changes the camera re-frames the model; edits keep the view
  selected?: string | null // highlighted group (a bin id)
  onPick?: (group: string | null) => void
  clipZ?: number | null // the layer slider's cut, mm
  onHeight?: (top: number) => void // the model's height, for the layer slider
  drag?: BinDrag // move bins by dragging them across the baseplate
}

/** Dragging whole groups (bins) across the plate in steps of one grid cell. */
export interface BinDrag {
  cell: number // mm per grid step
  canDrag: (group: string) => boolean
  onDrop: (group: string, dx: number, dy: number) => void // in cells; x right, y back
}

/**
 * Live 3D preview of meshes built in the geometry worker. Unlike Viewer3D (which loads a GLB), the
 * meshes are replaced in place on every edit, and the camera stays where the user put it.
 */
export default function PartsViewer({ parts, fitKey, selected = null, onPick, clipZ = null, onHeight, drag }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{
    scene: THREE.Scene
    root: THREE.Group
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    render: () => void
    resize: () => void
  } | null>(null)
  const pickRef = useRef(onPick)
  const dragRef = useRef(drag)
  useEffect(() => {
    pickRef.current = onPick
    dragRef.current = drag
  }, [onPick, drag])
  const fittedRef = useRef('')
  const planeRef = useRef(cutPlane())
  const sectionsRef = useRef<ReturnType<typeof addSections> | null>(null)
  const clipRef = useRef(clipZ)
  const heightRef = useRef(onHeight)
  useEffect(() => {
    heightRef.current = onHeight
  }, [onHeight])

  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 8000)
    camera.up.set(0, 0, 1)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.localClippingEnabled = true
    const canvas = renderer.domElement
    mount.appendChild(canvas)
    lightScene(scene, renderer)
    const root = new THREE.Group()
    scene.add(root)

    const render = () => renderer.render(scene, camera)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.addEventListener('change', render)
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      if (controls.update()) render()
    }
    tick()

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return // hidden (another page or tab): a zero-size camera would break the cut plane
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
      render()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    // A click (not a drag) picks the group under the pointer; pressing on a draggable group
    // (a bin) and moving slides it across the plate, snapped to whole cells.
    const raycaster = new THREE.Raycaster()
    const aim = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
    }
    const groupMeshes = (g: string) => (root.children as THREE.Mesh[]).filter((m) => m.userData.group === g)
    let press: { x: number; y: number } | null = null
    let slide: { group: string; plane: THREE.Plane; start: THREE.Vector3; dx: number; dy: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      press = { x: e.clientX, y: e.clientY }
      const d = dragRef.current
      if (!d || e.button !== 0) return
      aim(e)
      const hit = raycaster.intersectObjects(root.children, false)[0]
      const group = hit?.object.userData.group as string | undefined
      if (!hit || !group || !d.canDrag(group)) return
      e.stopImmediatePropagation() // the orbit controls don't get this press
      controls.enabled = false
      canvas.setPointerCapture(e.pointerId)
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z)
      slide = { group, plane, start: hit.point.clone(), dx: 0, dy: 0, moved: false }
    }
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!slide || !d) {
        if (d && !e.buttons) {
          aim(e)
          const g = raycaster.intersectObjects(root.children, false)[0]?.object.userData.group as string | undefined
          canvas.style.cursor = g && d.canDrag(g) ? 'grab' : ''
        }
        return
      }
      aim(e)
      const p = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(slide.plane, p)) return
      const dx = Math.round((p.x - slide.start.x) / d.cell)
      const dy = Math.round((p.y - slide.start.y) / d.cell)
      canvas.style.cursor = 'grabbing'
      if (dx === slide.dx && dy === slide.dy) return
      slide.dx = dx
      slide.dy = dy
      slide.moved = true
      for (const m of groupMeshes(slide.group)) m.position.set(dx * d.cell, dy * d.cell, 0)
      render()
    }
    const onUp = (e: PointerEvent) => {
      if (slide) {
        const s = slide
        slide = null
        controls.enabled = true
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
        canvas.style.cursor = ''
        if (s.dx || s.dy) dragRef.current?.onDrop(s.group, s.dx, s.dy)
        else {
          for (const m of groupMeshes(s.group)) m.position.set(0, 0, 0)
          render()
          if (!s.moved) pickRef.current?.(s.group)
        }
        press = null
        return
      }
      if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5 || !pickRef.current) return
      aim(e)
      const hit = raycaster.intersectObjects(root.children, false)[0]
      pickRef.current((hit?.object.userData.group as string | undefined) ?? null)
    }
    canvas.addEventListener('pointerdown', onDown, { capture: true })
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)

    sceneRef.current = { scene, root, camera, controls, render, resize }
    fittedRef.current = '' // a new scene (e.g. after a remount) has never been framed
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      canvas.removeEventListener('pointerdown', onDown, { capture: true })
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      for (const o of root.children as THREE.Mesh[]) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
      renderer.dispose()
      // Hand the WebGL context back now: browsers keep only ~16, and a view left to be garbage
      // collected would eventually push out a live one, leaving that preview blank.
      renderer.forceContextLoss()
      mount.removeChild(canvas)
      sceneRef.current = null
    }
  }, [])

  // Replace the meshes.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    for (const o of [...s.root.children] as THREE.Mesh[]) {
      s.root.remove(o)
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
      for (const c of o.children as THREE.Mesh[]) {
        ;(c.material as THREE.Material).dispose()
        if (c.geometry !== o.geometry) c.geometry.dispose()
      }
    }
    sectionsRef.current?.dispose()
    const meshes: THREE.Mesh[] = []
    for (const p of parts) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3))
      geo.setIndex(new THREE.BufferAttribute(p.indices, 1))
      geo.computeVertexNormals()
      const mat = new THREE.MeshLambertMaterial({ color: displayColour(p.hex), flatShading: true }) // diffuse only, like printed PLA
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.group = p.group
      addEdges(mesh, planeRef.current)
      s.root.add(mesh)
      meshes.push(mesh)
    }
    sectionsRef.current = addSections(meshes, planeRef.current, s.scene)
    sectionsRef.current.cut(clipRef.current)
    if (parts.length) heightRef.current?.(new THREE.Box3().setFromObject(s.root).max.z)
    if (parts.length && fittedRef.current !== fitKey) {
      fittedRef.current = fitKey
      s.resize() // frame for the real aspect ratio, which the first resize callback may not have set yet
      const box = new THREE.Box3().setFromObject(s.root)
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      const r = (Math.max(size.x, size.y, size.z * 1.2) * 1.35) / Math.min(1, s.camera.aspect)
      s.camera.position.set(centre.x - r * 0.45, centre.y - r * 1.25, centre.z + r * 0.95)
      s.controls.target.copy(centre)
      s.controls.update()
    }
    s.render()
  }, [parts, fitKey])

  // The layer slider's cut.
  useEffect(() => {
    clipRef.current = clipZ
    planeRef.current.constant = clipZ ?? NO_CUT
    sectionsRef.current?.cut(clipZ)
    sceneRef.current?.render()
  }, [clipZ])

  // Highlight the selected bin.
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    for (const o of s.root.children as THREE.Mesh[]) {
      const mat = o.material as THREE.MeshLambertMaterial
      mat.emissive.set(selected && o.userData.group === selected ? '#1a2633' : '#000000')
    }
    s.render()
  }, [selected, parts])

  return <div className="viewer" ref={mountRef} aria-label="3D preview. Drag to orbit, scroll to zoom." />
}
