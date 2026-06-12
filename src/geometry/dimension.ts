import type { FloorPlan, Point } from '../types/model'
import type { WallProbe } from '../store/usePlanStore'

export interface Dimension {
  wallId: string // the facing parallel wall being measured to
  from: Point // the probed point on the clicked wall
  to: Point // the point on the facing parallel wall
  distance: number // mm
}

const isHorizontal = (a: Point, b: Point) =>
  Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)

/** From the clicked point, shoot perpendicular rays (both sides) and measure to
 *  the nearest parallel wall the ray crosses. Returns up to two dimensions. */
export function computeProbeDimensions(
  plan: FloorPlan,
  probe: WallProbe,
): Dimension[] {
  const wall = plan.walls[probe.wallId]
  if (!wall) return []
  const a = wall.a
  const b = wall.b

  const horizontal = isHorizontal(a, b)
  const P: Point = {
    x: a.x + (b.x - a.x) * probe.t,
    y: a.y + (b.y - a.y) * probe.t,
  }

  // nearest crossing on each side (signed offset along the perpendicular axis)
  let posBest: Dimension | null = null // offset > 0
  let negBest: Dimension | null = null // offset < 0

  for (const c of Object.values(plan.walls)) {
    if (c.id === probe.wallId) continue
    const ca = c.a
    const cb = c.b
    if (isHorizontal(ca, cb) !== horizontal) continue // must be parallel

    let hit: Point | null = null
    let offset = 0
    if (horizontal) {
      // perpendicular ray is vertical (x = P.x); candidate must span P.x
      const lo = Math.min(ca.x, cb.x)
      const hi = Math.max(ca.x, cb.x)
      if (P.x < lo || P.x > hi || cb.x === ca.x) continue
      const u = (P.x - ca.x) / (cb.x - ca.x)
      const y = ca.y + (cb.y - ca.y) * u
      offset = y - P.y
      hit = { x: P.x, y }
    } else {
      // perpendicular ray is horizontal (y = P.y); candidate must span P.y
      const lo = Math.min(ca.y, cb.y)
      const hi = Math.max(ca.y, cb.y)
      if (P.y < lo || P.y > hi || cb.y === ca.y) continue
      const u = (P.y - ca.y) / (cb.y - ca.y)
      const x = ca.x + (cb.x - ca.x) * u
      offset = x - P.x
      hit = { x, y: P.y }
    }

    if (Math.abs(offset) < 1) continue // essentially the same line
    const dim: Dimension = {
      wallId: c.id,
      from: P,
      to: hit,
      distance: Math.abs(offset),
    }
    if (offset > 0) {
      if (!posBest || dim.distance < posBest.distance) posBest = dim
    } else {
      if (!negBest || dim.distance < negBest.distance) negBest = dim
    }
  }

  return [posBest, negBest].filter((d): d is Dimension => d !== null)
}
