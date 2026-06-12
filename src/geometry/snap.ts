import type { FloorPlan, Point } from '../types/model'
import type { Viewport } from './viewport'

export const GRID_SIZE_MM = 100 // 10 cm grid

export interface SnapResult {
  point: Point
  atEndpoint?: boolean // snapped onto another wall's endpoint
  onWall?: boolean // snapped onto a wall body
}

export interface WallHit {
  wallId: string
  point: Point // projection of the query point onto the wall
  dist: number // world-space distance (mm)
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Closest point on segment a–b to p, clamped to the segment. */
function projectOnSegment(p: Point, a: Point, b: Point): Point {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return { ...a }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2
  t = Math.max(0, Math.min(1, t))
  return { x: a.x + abx * t, y: a.y + aby * t }
}

/** Intersection of ray (origin o, unit dir d, t>=0) with segment a-b, or null. */
function raySegment(o: Point, d: Point, a: Point, b: Point): Point | null {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const denom = d.x * ey - d.y * ex
  if (Math.abs(denom) < 1e-9) return null // parallel
  const ax = a.x - o.x
  const ay = a.y - o.y
  const t = (ax * ey - ay * ex) / denom
  const u = (ax * d.y - ay * d.x) / denom
  if (t < -1e-6 || u < -1e-6 || u > 1 + 1e-6) return null
  return { x: o.x + d.x * t, y: o.y + d.y * t }
}

/** Nearest wall whose body is within `pxThreshold` screen px of `world`. */
export function nearestWall(
  world: Point,
  plan: FloorPlan,
  vp: Viewport,
  excludeWallIds: string[],
  pxThreshold = 12,
): WallHit | null {
  const worldThresh = pxThreshold / vp.scale
  let best: WallHit | null = null
  for (const w of Object.values(plan.walls)) {
    if (excludeWallIds.includes(w.id)) continue
    const proj = projectOnSegment(world, w.a, w.b)
    const d = dist(world, proj)
    if (d <= worldThresh && (!best || d < best.dist)) {
      best = { wallId: w.id, point: proj, dist: d }
    }
  }
  return best
}

/** Nearest wall endpoint within `worldRadius` of `world`. */
function nearestEndpoint(
  world: Point,
  plan: FloorPlan,
  worldRadius: number,
  excludeWallIds: string[],
): Point | null {
  let best: { p: Point; d: number } | null = null
  for (const w of Object.values(plan.walls)) {
    if (excludeWallIds.includes(w.id)) continue
    for (const p of [w.a, w.b]) {
      const d = dist(world, p)
      if (d <= worldRadius && (!best || d < best.d)) best = { p, d }
    }
  }
  return best ? { ...best.p } : null
}

/** Resolve a raw world point into a snapped point. Priority: an existing wall
 *  endpoint, then a 15° angle relative to `from` (optionally landing on a wall
 *  body it crosses), then a wall body, then the grid. */
export function snap(
  world: Point,
  plan: FloorPlan,
  vp: Viewport,
  opts: {
    from?: Point | null
    ortho?: boolean
    pxRadius?: number
    excludeWallIds?: string[]
    snapEndpoints?: boolean
    snapWalls?: boolean
  } = {},
): SnapResult {
  const pxRadius = opts.pxRadius ?? 12
  const worldRadius = pxRadius / vp.scale
  const exclude = opts.excludeWallIds ?? []

  // 1. snap to an existing wall endpoint
  if (opts.snapEndpoints ?? true) {
    const ep = nearestEndpoint(world, plan, worldRadius, exclude)
    if (ep) return { point: ep, atEndpoint: true }
  }

  // 2. angle snap to 15° increments relative to the drawing start point. If the
  //    ray crosses a nearby wall, land on that wall (keeping the angle).
  if (opts.from && opts.ortho) {
    const dx = world.x - opts.from.x
    const dy = world.y - opts.from.y
    const step = Math.PI / 12 // 15°
    const ang = Math.round(Math.atan2(dy, dx) / step) * step
    const dir = { x: Math.cos(ang), y: Math.sin(ang) }

    if (opts.snapWalls) {
      let bestPt: Point | null = null
      let bestD = Infinity
      for (const w of Object.values(plan.walls)) {
        if (exclude.includes(w.id)) continue
        const hit = raySegment(opts.from, dir, w.a, w.b)
        if (!hit) continue
        const d = dist(world, hit)
        if (d <= worldRadius && d < bestD) {
          bestD = d
          bestPt = hit
        }
      }
      if (bestPt) return { point: bestPt, onWall: true }
    }

    const len = Math.round(Math.hypot(dx, dy) / GRID_SIZE_MM) * GRID_SIZE_MM
    return {
      point: { x: opts.from.x + dir.x * len, y: opts.from.y + dir.y * len },
    }
  }

  // 3. snap onto a wall body (free angle)
  if (opts.snapWalls) {
    const hit = nearestWall(world, plan, vp, exclude)
    if (hit) return { point: hit.point, onWall: true }
  }

  // 4. grid snap
  return {
    point: {
      x: Math.round(world.x / GRID_SIZE_MM) * GRID_SIZE_MM,
      y: Math.round(world.y / GRID_SIZE_MM) * GRID_SIZE_MM,
    },
  }
}
