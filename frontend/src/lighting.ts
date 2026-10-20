// One lighting setup for every 3D preview. The aim is that a face turned up towards the viewer
// shows about the filament's own colour, the way it looks on the bed: a soft sky/ground fill, one
// key light for shape, a faint cool fill from behind, and neutral tone mapping so light
// filaments don't blow out to white or push saturated ones to neon.
import * as THREE from 'three'

export function lightScene(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1
  scene.add(new THREE.HemisphereLight('#ffffff', '#3a3f45', LIGHT.fill))
  const key = new THREE.DirectionalLight('#ffffff', LIGHT.key)
  key.position.set(-70, -110, 190)
  scene.add(key)
  const back = new THREE.DirectionalLight('#dde6f5', LIGHT.back)
  back.position.set(140, 160, 70)
  scene.add(back)
}

export const LIGHT = { fill: 2.3, key: 2.0, back: 0.45 }
