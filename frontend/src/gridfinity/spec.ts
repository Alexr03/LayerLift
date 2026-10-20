// Gridfinity dimensions, in millimetres. The numbers follow Gridfinity Rebuilt
// (github.com/kennetek/gridfinity-rebuilt-openscad, src/core/standard.scad), which is the
// de-facto reference for Zack Freedman's system. A bin 0.2 mm off rattles or won't seat, so
// the tests check the built geometry against these values.

/** Grid pitch: one cell is 42 × 42 mm. */
export const PITCH = 42
/** One height unit. A bin of height u is 7·u mm tall to the top of its wall; the lip sits on top. */
export const HEIGHT_UNIT = 7
/** A bin's outside is 0.5 mm smaller than its cells (0.25 mm clearance each side). */
export const BIN_CLEARANCE = 0.5
/** Outer corner radius of a bin (at its full 41.5 mm size). */
export const BIN_RADIUS = 3.75

/**
 * The foot under each cell, bottom up, as [inset from the full 41.5 mm outline, z]. 45° chamfer,
 * straight, 45° chamfer: 0.8 + 1.8 + 2.15 = 4.75 mm.
 */
export const FOOT_PROFILE: [number, number][] = [
  [2.95, 0],
  [2.15, 0.8],
  [2.15, 2.6],
  [0, 4.75],
]
export const FOOT_HEIGHT = 4.75
/**
 * Where a multi-cell bin's solid bridge starts: level with the top of a baseplate's ridges (5 mm),
 * with each foot carried straight up to it. Bridging at 4.75 would sit on the 0.25 mm peak of the
 * ridge between two cells instead of on the chamfers.
 */
export const BRIDGE_Z = 5
/** Solid base under the floor: the foot plus a bridge, 7 mm in all. */
export const BASE_HEIGHT = 7

/**
 * The receptacle in a baseplate cell, top down, as [inset from the 42 mm cell, height above the
 * plate's bottom]. 0.7 + 1.8 + 2.15 = 4.65 mm of profile on 0.35 mm of straight clearance: a bin's
 * foot rests on the chamfers with its bottom level with the plate's bottom.
 */
export const PLATE_PROFILE: [number, number][] = [
  [2.85, 0],
  [2.85, 0.35],
  [2.15, 1.05],
  [2.15, 2.85],
  [0, 5],
]
export const PLATE_HEIGHT = 5
/** Corner radius of a baseplate cell's opening. */
export const PLATE_RADIUS = 4

/**
 * Stacking lip on top of the wall, as [inset from the outer wall, z above the wall top].
 * Rebuilt's profile is 0.7 + 1.8 + 1.9 = 4.4 mm to a knife edge; like Rebuilt (which rounds it with a
 * 0.6 mm fillet) the top is blunted, here to a 0.6 mm flat. That doesn't change how bins stack.
 */
export const LIP_PROFILE: [number, number][] = [
  [2.6, 0],
  [1.9, 0.7],
  [1.9, 2.5],
  [0.6, 3.8],
]
export const LIP_HEIGHT = 3.8
/** Straight part of the lip's inside below the wall top, before the 45° support to the wall. */
export const LIP_SUPPORT = 1.2

/** Magnet and screw holes: centred 8 mm in from each side of a cell, i.e. ±13 mm from its centre. */
export const HOLE_OFFSET = 13
export const MAGNET_DIAMETER = 6.5
export const MAGNET_DEPTH = 2.4
export const SCREW_DIAMETER = 3
export const SCREW_DEPTH = 6

/**
 * A grid: cell pitch and height unit. Standard Gridfinity is 42 × 7; each baseplate can set its
 * own, and the bins on it follow. The foot, lip and receptacle profiles stay the same.
 */
export interface GridSpec {
  pitch: number
  unit: number
}
export const DEFAULT_GRID: GridSpec = { pitch: PITCH, unit: HEIGHT_UNIT }
/** Magnet and screw holes sit 8 mm in from each side of a cell (±13 mm at the standard 42). */
export const holeOffset = (pitch: number) => pitch / 2 - 8

/**
 * Connection clips, measured from Gridfinity Generator's connectable baseplate and clip so the two
 * are interchangeable. Along the middle 20 mm of each clipped edge the ridge is cut away above a
 * rail; the clip snaps down over the two pieces' rails (barbs under the rail's shoulder) and
 * rebuilds the ridge. All heights are below the plate's top, as on Generator's 4.65 mm plate
 * (Rebuilt's 5 mm plate adds its 0.35 mm clearance underneath, so the top-relative shape is equal).
 *
 * RAIL: the part of the wall that stays, as [distance from the edge, depth below the top], from
 * where the cell's wall is cut back to the rail's top. CLIP: the clip's end outline, [across the
 * seam, depth below the top], extruded CLIP_LENGTH.
 */
export const CLIP_CUT = 20 // mm of edge cut back for each clip
export const CLIP_LENGTH = 19.6
export const RAIL: [number, number][] = [
  [1.0, 3.95],
  [1.0, 3.55],
  [1.15, 3.35],
  [1.3, 3.15],
  [1.3, 2.65],
]
export const CLIP: [number, number][] = [
  [-1.05, 3.55],
  [-1.05, 3.8],
  [-2.15, 3.8],
  [-2.15, 2.15],
  [-0.212, 0.212],
  [-0.16, 0.17],
  [-0.099, 0.141],
  [-0.034, 0.126],
  [0.034, 0.126],
  [0.099, 0.141],
  [0.16, 0.17],
  [0.212, 0.212],
  [2.15, 2.15],
  [2.15, 3.8],
  [1.05, 3.8],
  [1.05, 3.55],
  [1.45, 3.017],
  [1.45, 2.45],
  [-1.45, 2.45],
  [-1.45, 3.017],
]

/** Divider wall thickness. */
export const DIVIDER = 1.2
