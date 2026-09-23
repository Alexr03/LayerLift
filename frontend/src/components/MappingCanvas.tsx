import { useEffect, useMemo, useRef, useState } from 'react'
import type { Analysis } from '../api'

interface Props {
  analysis: Analysis
  imageUrl: string
  regionColours: string[] // hex per region
  selected: number | null
  onSelect: (region: number | null) => void
  showOriginal: boolean
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** Decode the region-id PNG (RGB = id + 1) into an Int32Array of region ids (-1 = background). */
async function decodeRegionMap(analysis: Analysis): Promise<Int32Array> {
  const img = new Image()
  img.src = `data:image/png;base64,${analysis.region_map_png}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = analysis.width
  canvas.height = analysis.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, analysis.width, analysis.height).data
  const ids = new Int32Array(analysis.width * analysis.height)
  for (let i = 0, p = 0; i < ids.length; i++, p += 4) {
    ids[i] = ((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) - 1
  }
  return ids
}

export default function MappingCanvas({ analysis, imageUrl, regionColours, selected, onSelect, showOriginal }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Decoded ids are tagged with the analysis they belong to, so a new analysis shows nothing stale.
  const [decoded, setDecoded] = useState<{ key: string; ids: Int32Array } | null>(null)
  const ids = decoded?.key === analysis.analysis_id ? decoded.ids : null
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    decodeRegionMap(analysis).then((d) => alive && setDecoded({ key: analysis.analysis_id, ids: d }))
    return () => {
      alive = false
    }
  }, [analysis])

  const lut = useMemo(() => regionColours.map(hexToRgb), [regionColours])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !ids) return
    const { width: w, height: h } = analysis
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const out = ctx.createImageData(w, h)
    const px = out.data
    const focus = selected ?? hover
    for (let i = 0, p = 0; i < ids.length; i++, p += 4) {
      const id = ids[i]
      if (id < 0) continue
      const [r, g, b] = lut[id] ?? [255, 0, 255]
      if (focus != null && id !== focus && selected != null) {
        // Dim everything except the selected region.
        px[p] = r * 0.35 + 150 * 0.65
        px[p + 1] = g * 0.35 + 150 * 0.65
        px[p + 2] = b * 0.35 + 150 * 0.65
      } else {
        px[p] = r
        px[p + 1] = g
        px[p + 2] = b
      }
      px[p + 3] = 255
    }
    ctx.putImageData(out, 0, 0)
    if (hover != null && hover !== selected) {
      // Outline the hovered region's bounding box.
      const reg = analysis.regions[hover]
      if (reg) {
        ctx.strokeStyle = 'rgba(199,150,47,0.95)'
        ctx.lineWidth = Math.max(1, w / 400)
        ctx.setLineDash([4, 3])
        ctx.strokeRect(reg.bbox[0] - 1.5, reg.bbox[1] - 1.5, reg.bbox[2] + 3, reg.bbox[3] + 3)
      }
    }
  }, [ids, lut, selected, hover, analysis])

  const regionAt = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    if (!ids) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * analysis.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * analysis.height)
    if (x < 0 || y < 0 || x >= analysis.width || y >= analysis.height) return null
    const id = ids[y * analysis.width + x]
    return id >= 0 ? id : null
  }

  return (
    <div className="map-canvas" style={{ aspectRatio: `${analysis.width} / ${analysis.height}` }}>
      <canvas
        ref={canvasRef}
        className={showOriginal ? 'hidden' : ''}
        onMouseMove={(e) => setHover(regionAt(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onSelect(regionAt(e))}
        role="img"
        aria-label="Colour mapping preview. Click a region to change its filament."
      />
      {showOriginal && <img src={imageUrl} alt="Uploaded image" />}
      {!ids && <div className="canvas-note">Preparing regions…</div>}
    </div>
  )
}
