import { useRef, useState } from 'react'
import { type Grid, type Piece, clipSpots } from '../../gridfinity/layout'
import { CLIP_CUT } from '../../gridfinity/spec'
import { type PlacedBin, type Scene, binSize } from '../../gridfinity/types'
import { inkOn, onPlate } from '../../palettes'

interface Props {
  project: Scene
  grid: Grid
  pieces: Piece[]
  selected: string[]
  problems: Set<string>
  onSelect: (id: string | null, additive: boolean) => void // shift- or ctrl-click adds to the selection
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, d: number) => void
  onDraw: (x: number, y: number, w: number, d: number) => void
}

type Session =
  | { kind: 'draw'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; id: string; dx: number; dy: number; x: number; y: number; moved: boolean }
  | { kind: 'resize'; id: string; w: number; d: number }

const INSET = 1 // mm between a bin's drawing and its cells, so neighbours read as separate

/**
 * The drawer from above, front at the bottom. Drag across empty cells to add a bin; drag a bin to
 * move it; drag its corner handle to resize it.
 */
export default function Planner({ project, grid, pieces, selected, problems, onSelect, onMove, onResize, onDraw }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [session, setSession] = useState<Session | null>(null)
  const PITCH = grid.pitch
  const W = grid.width
  const D = grid.depth
  const sy = (y: number) => D - y // mm from the front → SVG y

  /** The cell under a pointer (clamped to the grid), in cells from the front-left. */
  /** The cell under a pointer, unclamped: it may lie outside the grid. */
  const rawCell = (e: React.PointerEvent): [number, number] => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return [Math.floor((p.x - grid.padLeft) / PITCH), Math.floor((D - p.y - grid.padFront) / PITCH)]
  }
  /** The cell under a pointer, clamped to the grid (for drags that wander off it). */
  const cellAt = (e: React.PointerEvent): [number, number] => {
    const [cx, cy] = rawCell(e)
    return [Math.max(0, Math.min(grid.nx - 1, cx)), Math.max(0, Math.min(grid.ny - 1, cy))]
  }

  const binAt = (x: number, y: number) => project.bins.find((b) => x >= b.x && x < b.x + b.design.w && y >= b.y && y < b.y + b.design.d)

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as Element
    const [x, y] = cellAt(e)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const handle = target.closest('[data-resize]')?.getAttribute('data-resize')
    if (handle) {
      const b = project.bins.find((v) => v.id === handle)!
      setSession({ kind: 'resize', id: b.id, w: b.design.w, d: b.design.d })
      return
    }
    const id = target.closest('[data-bin]')?.getAttribute('data-bin')
    const [rx, ry] = rawCell(e)
    const onGrid = rx >= 0 && ry >= 0 && rx < grid.nx && ry < grid.ny
    const b = id ? project.bins.find((v) => v.id === id) : onGrid ? binAt(x, y) : undefined
    if (!b && !onGrid) {
      // Outside the cells (the margin or the background): only clears the selection.
      ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
      if (selected.length) onSelect(null, false)
      return
    }
    if (b) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      onSelect(b.id, additive)
      if (!additive) setSession({ kind: 'move', id: b.id, dx: x - b.x, dy: y - b.y, x: b.x, y: b.y, moved: false })
    } else setSession({ kind: 'draw', x0: x, y0: y, x1: x, y1: y })
  }

  const move = (e: React.PointerEvent) => {
    if (!session) return
    const [x, y] = cellAt(e)
    if (session.kind === 'draw') setSession({ ...session, x1: x, y1: y })
    else if (session.kind === 'move') {
      const b = project.bins.find((v) => v.id === session.id)!
      const nx = Math.max(0, Math.min(grid.nx - b.design.w, x - session.dx))
      const ny = Math.max(0, Math.min(grid.ny - b.design.d, y - session.dy))
      if (nx !== session.x || ny !== session.y) setSession({ ...session, x: nx, y: ny, moved: true })
    } else {
      const b = project.bins.find((v) => v.id === session.id)!
      setSession({ ...session, w: Math.max(1, Math.min(10, x - b.x + 1)), d: Math.max(1, Math.min(10, y - b.y + 1)) })
    }
  }

  const up = () => {
    const s = session
    setSession(null)
    if (!s) return
    if (s.kind === 'draw') {
      const x = Math.min(s.x0, s.x1)
      const y = Math.min(s.y0, s.y1)
      const w = Math.abs(s.x1 - s.x0) + 1
      const d = Math.abs(s.y1 - s.y0) + 1
      // A click on an empty cell clears the selection; a drag (or a click with nothing selected) adds a bin.
      if (w === 1 && d === 1 && selected.length) onSelect(null, false)
      else onDraw(x, y, Math.min(10, w), Math.min(10, d))
    } else if (s.kind === 'move' && s.moved) onMove(s.id, s.x, s.y)
    else if (s.kind === 'resize') {
      const b = project.bins.find((v) => v.id === s.id)!
      if (s.w !== b.design.w || s.d !== b.design.d) onResize(s.id, s.w, s.d)
    }
  }

  const shown = (b: PlacedBin): PlacedBin => {
    if (session?.kind === 'move' && session.id === b.id) return { ...b, x: session.x, y: session.y }
    if (session?.kind === 'resize' && session.id === b.id) return { ...b, design: { ...b.design, w: session.w, d: session.d } }
    return b
  }

  const cells = []
  for (let i = 0; i < grid.nx; i++)
    for (let j = 0; j < grid.ny; j++)
      cells.push(<rect key={`${i}-${j}`} className="pl-cell" x={grid.padLeft + i * PITCH + 1.2} y={sy(grid.padFront + (j + 1) * PITCH) + 1.2} width={PITCH - 2.4} height={PITCH - 2.4} rx={4} />)

  const draft =
    session?.kind === 'draw'
      ? {
          x: Math.min(session.x0, session.x1),
          y: Math.min(session.y0, session.y1),
          w: Math.abs(session.x1 - session.x0) + 1,
          d: Math.abs(session.y1 - session.y0) + 1,
        }
      : null

  // Clip spots over the whole baseplate; a seam is shared by two pieces, so each is drawn once.
  const clips = (() => {
    const seen = new Map<string, { key: string; x: number; y: number; acrossX: boolean; seam: boolean; len: number }>()
    for (const p of pieces)
      for (const s of clipSpots(p, project.drawer)) {
        const x = p.x + s.x
        const y = p.y + s.y
        const key = `${x.toFixed(2)},${y.toFixed(2)}`
        const seam = s.acrossX ? (s.x === 0 ? p.joins.left : p.joins.right) : s.y === 0 ? p.joins.front : p.joins.back
        seen.set(key, { key, x, y, acrossX: s.acrossX, seam, len: Math.min(CLIP_CUT, PITCH - 22) })
      }
    return [...seen.values()]
  })()

  const font = 5.2
  return (
    <svg
      ref={svgRef}
      className={session ? 'planner active' : 'planner'}
      viewBox={`-6 -6 ${W + 12} ${D + 12}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setSession(null)}
      role="application"
      aria-label={`Drawer layout, ${grid.nx} by ${grid.ny} cells. Drag across empty cells to add a bin.`}
    >
      <rect className="pl-plate" x={0} y={0} width={W} height={D} rx={1.5} />
      {cells}
      {pieces.length > 1 &&
        pieces
          .filter((p) => p.col > 0 || p.row > 0)
          .map((p) => (
            <g key={p.index} className="pl-split">
              {p.col > 0 && <line x1={p.x} x2={p.x} y1={sy(p.y)} y2={sy(p.y + p.depth)} />}
              {p.row > 0 && <line x1={p.x} x2={p.x + p.width} y1={sy(p.y)} y2={sy(p.y)} />}
            </g>
          ))}
      {project.bins.map((raw) => {
        const b = shown(raw)
        const x = grid.padLeft + b.x * PITCH + INSET
        const yTop = sy(grid.padFront + (b.y + b.design.d) * PITCH) + INSET
        const w = b.design.w * PITCH - 2 * INSET
        const h = b.design.d * PITCH - 2 * INSET
        const hex = onPlate(project.filaments[b.design.body]?.hex ?? '#8C9196')
        const ink = inkOn(hex)
        const cols = b.design.divX + 1
        const rows = b.design.divY + 1
        const lines = []
        for (let k = 1; k < cols; k++) lines.push(<line key={`x${k}`} x1={x + (w * k) / cols} x2={x + (w * k) / cols} y1={yTop + 3} y2={yTop + h - 3} />)
        for (let k = 1; k < rows; k++) lines.push(<line key={`y${k}`} y1={yTop + (h * k) / rows} y2={yTop + (h * k) / rows} x1={x + 3} x2={x + w - 3} />)
        const labels = b.design.labels
        const sel = selected.includes(raw.id)
        const only = sel && selected.length === 1
        return (
          <g key={raw.id} data-bin={raw.id} className={`pl-bin${sel ? ' on' : ''}${problems.has(raw.id) ? ' bad' : ''}`}>
            <rect x={x} y={yTop} width={w} height={h} rx={4} fill={hex} />
            <g className="pl-div" stroke={ink}>
              {lines}
            </g>
            {Array.from({ length: cols * rows }, (_, i) => {
              const text = labels[i]?.trim()
              if (!text) return null
              const c = i % cols
              const r = Math.floor(i / cols) // row 0 is the front, drawn at the bottom
              const cw = w / cols
              const ch = h / rows
              return (
                <text key={i} x={x + cw * (c + 0.5)} y={yTop + h - ch * (r + 0.5)} fill={ink} fontSize={Math.min(font, ch * 0.3)} textAnchor="middle" dominantBaseline="central">
                  {text.length > Math.floor(cw / 3) ? `${text.slice(0, Math.max(1, Math.floor(cw / 3) - 1))}…` : text}
                </text>
              )
            })}
            <text className="pl-size" x={x + 3} y={yTop + h - 3} fill={ink} fontSize={3.8}>
              {binSize(b.design)}
            </text>
            {only && <rect data-resize={raw.id} className="pl-handle" x={x + w - 7} y={yTop - 1} width={8} height={8} rx={1.5} />}
          </g>
        )
      })}
      {draft && <rect className="pl-draft" x={grid.padLeft + draft.x * PITCH + INSET} y={sy(grid.padFront + (draft.y + draft.d) * PITCH) + INSET} width={draft.w * PITCH - 2 * INSET} height={draft.d * PITCH - 2 * INSET} rx={4} />}
      {draft && (
        <text className="pl-draft-label" x={grid.padLeft + (draft.x + draft.w / 2) * PITCH} y={sy(grid.padFront + (draft.y + draft.d / 2) * PITCH)} textAnchor="middle" dominantBaseline="central" fontSize={7}>
          {draft.w}×{draft.d}
        </text>
      )}
      {clips.map((c) => (
        <rect
          key={c.key}
          className="pl-clip"
          x={c.acrossX ? c.x - 1.3 : c.x - c.len / 2}
          y={c.acrossX ? sy(c.y) - c.len / 2 : sy(c.y) - 1.3}
          width={c.acrossX ? 2.6 : c.len}
          height={c.acrossX ? c.len : 2.6}
          rx={0.8}
        >
          <title>{c.seam ? 'Clip across the seam between pieces' : 'Clip hole on the outer edge'}</title>
        </rect>
      ))}
      <text className="pl-front" x={W / 2} y={D + 5} textAnchor="middle" fontSize={4}>
        Front of the drawer
      </text>
      {clips.length > 0 && (
        <g className="pl-clip-key">
          <rect className="pl-clip" x={0} y={D + 2.9} width={8} height={2.2} rx={0.8} />
          <text x={10} y={D + 5} fontSize={4}>
            {clips.length} clip{clips.length === 1 ? '' : 's'}
          </text>
        </g>
      )}
    </svg>
  )
}
