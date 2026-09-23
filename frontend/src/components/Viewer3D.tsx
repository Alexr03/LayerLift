import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

interface Props {
  url: string
  explode: number // 0..1, lifts each part apart to show the layering
}

export default function Viewer3D({ url, explode }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const partsRef = useRef<THREE.Object3D[]>([])
  const renderRef = useRef<() => void>(() => {})

  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000)
    camera.up.set(0, 0, 1) // the model is Z-up millimetres
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) // transparent: the work surface shows through
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 1.1))
    const key = new THREE.DirectionalLight('#ffffff', 1.8)
    key.position.set(-80, -120, 200)
    scene.add(key)
    const rim = new THREE.DirectionalLight('#ffffff', 0.6)
    rim.position.set(120, 150, 80)
    scene.add(rim)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const render = () => renderer.render(scene, camera)
    renderRef.current = render
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
      const parts: THREE.Object3D[] = []
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh
          const mat = mesh.material as THREE.MeshStandardMaterial
          mat.flatShading = true
          mat.needsUpdate = true
          parts.push(mesh)
          mesh.userData.baseZ = mesh.position.z
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
      render()
    })
    tick()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry.dispose()
          ;(m.material as THREE.Material).dispose()
        }
      })
      mount.removeChild(renderer.domElement)
    }
  }, [url])

  useEffect(() => {
    // Parts are stored in the order of the filament list; lift each one a little more.
    partsRef.current.forEach((p, i) => {
      p.position.z = (p.userData.baseZ ?? 0) + explode * 6 * i
    })
    renderRef.current()
  }, [explode])

  return <div className="viewer" ref={mountRef} aria-label="3D preview. Drag to orbit, scroll to zoom." />
}
