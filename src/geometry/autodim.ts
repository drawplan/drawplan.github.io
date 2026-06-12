import type { FloorPlan, Wall } from '../types/model'

export interface AutoDim {
  axis: 'h' | 'v' // h = horizontal chain (top/bottom), v = vertical (left/right)
  line: number // world coord of the dimension line (y for h, x for v)
  edge: number // bbox edge the witness lines start from
  ticks: number[] // sorted unique positions along the axis (x for h, y for v)
}

const OFFSET = 1500 // first dimension line, 1.5 m outside the bounding box
// extra distance to the overall-total line; vertical chains carry horizontal
// text labels, so they get a bit more room
const GAP = { h: 800, v: 900 } as const

const isVertical = (w: Wall) =>
  Math.abs(w.b.y - w.a.y) > Math.abs(w.b.x - w.a.x)
const wallLen = (w: Wall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
const reaches = (lo: number, hi: number, edge: number, tol: number) =>
  lo - tol <= edge && edge <= hi + tol

const uniqSort = (arr: number[]) =>
  [...new Set(arr.map((v) => Math.round(v)))].sort((a, b) => a - b)

function chain(
  axis: 'h' | 'v',
  edge: number,
  sign: 1 | -1,
  lo: number,
  hi: number,
  subs: number[],
): AutoDim[] {
  if (hi - lo < 1) return []
  const s = uniqSort(subs.filter((c) => c > lo + 1 && c < hi - 1))
  if (s.length) {
    return [
      { axis, line: edge + sign * OFFSET, edge, ticks: uniqSort([lo, ...s, hi]) },
      { axis, line: edge + sign * (OFFSET + GAP[axis]), edge, ticks: [lo, hi] },
    ]
  }
  return [{ axis, line: edge + sign * OFFSET, edge, ticks: [lo, hi] }]
}

/** Auto dimensions surrounding the plan, 2 m outside the bounding box. Each
 *  side is subdivided where interior walls meet the exterior, with the overall
 *  total on an outer line; sides with no interior contact show only the total. */
export function computeAutoDimensions(plan: FloorPlan): AutoDim[] {
  let ext = Object.values(plan.walls).filter((w) => w.kind === 'exterior')
  let int = Object.values(plan.walls).filter((w) => w.kind === 'interior')
  if (ext.length === 0) {
    ext = Object.values(plan.walls)
    int = []
  }
  if (ext.length === 0) return []

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const w of ext) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  }

  // subdivisions: interior walls that reach a bbox edge divide that side
  const TOL = 350 // covers an interior wall ending at the boundary's inner face
  const subs = { bottom: [] as number[], top: [], left: [], right: [] } as Record<
    'bottom' | 'top' | 'left' | 'right',
    number[]
  >
  for (const w of int) {
    if (wallLen(w) < 1) continue
    if (isVertical(w)) {
      const x = (w.a.x + w.b.x) / 2
      const ylo = Math.min(w.a.y, w.b.y)
      const yhi = Math.max(w.a.y, w.b.y)
      if (reaches(ylo, yhi, maxY, TOL)) subs.bottom.push(x)
      if (reaches(ylo, yhi, minY, TOL)) subs.top.push(x)
    } else {
      const y = (w.a.y + w.b.y) / 2
      const xlo = Math.min(w.a.x, w.b.x)
      const xhi = Math.max(w.a.x, w.b.x)
      if (reaches(xlo, xhi, minX, TOL)) subs.left.push(y)
      if (reaches(xlo, xhi, maxX, TOL)) subs.right.push(y)
    }
  }
  // wall endpoints lying on a bbox edge also divide that side — joints where
  // collinear exterior segments (or transparent fillers) meet end-to-end
  const ETOL = 10
  for (const w of [...ext, ...int]) {
    if (wallLen(w) < 1) continue
    for (const p of [w.a, w.b]) {
      if (Math.abs(p.y - maxY) <= ETOL) subs.bottom.push(p.x)
      if (Math.abs(p.y - minY) <= ETOL) subs.top.push(p.x)
      if (Math.abs(p.x - minX) <= ETOL) subs.left.push(p.y)
      if (Math.abs(p.x - maxX) <= ETOL) subs.right.push(p.y)
    }
  }

  return [
    ...chain('h', maxY, 1, minX, maxX, subs.bottom),
    ...chain('h', minY, -1, minX, maxX, subs.top),
    ...chain('v', minX, -1, minY, maxY, subs.left),
    ...chain('v', maxX, 1, minY, maxY, subs.right),
  ]
}
