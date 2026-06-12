import type { FloorPlan } from '../types/model'

/** The segment of wall `wallId` around `pos` (mm from a), bounded by joints
 *  where other walls touch it and by the wall's own ends. Returns [lo, hi]. */
export function wallSegmentAt(
  plan: FloorPlan,
  wallId: string,
  pos: number,
): [number, number] {
  const w = plan.walls[wallId]
  if (!w) return [0, 0]
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
  const ux = (w.b.x - w.a.x) / len
  const uy = (w.b.y - w.a.y) / len
  const joints = [0, len]
  for (const v of Object.values(plan.walls)) {
    if (v.id === wallId) continue
    for (const p of [v.a, v.b]) {
      const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy
      const perp = Math.abs((p.x - w.a.x) * -uy + (p.y - w.a.y) * ux)
      if (t > 1 && t < len - 1 && perp <= w.thickness / 2 + v.thickness / 2 + 20) {
        joints.push(t)
      }
    }
  }
  const lo = Math.max(...joints.filter((j) => j <= pos), 0)
  const hi = Math.min(...joints.filter((j) => j >= pos), len)
  return [lo, hi]
}

/** Like wallSegmentAt, but bounded by the FACES of adjoining walls (안목
 *  치수) instead of their centerlines. Corner walls at the ends count too;
 *  free wall ends bound at the end itself. */
export function wallSegmentFacesAt(
  plan: FloorPlan,
  wallId: string,
  pos: number,
): [number, number] {
  const w = plan.walls[wallId]
  if (!w) return [0, 0]
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
  const ux = (w.b.x - w.a.x) / len
  const uy = (w.b.y - w.a.y) / len
  let lo = 0
  let hi = len
  const bound = (t: number, faceOff: number) => {
    if (t <= pos) lo = Math.max(lo, Math.min(pos, t + faceOff))
    if (t >= pos) hi = Math.min(hi, Math.max(pos, t - faceOff))
  }
  for (const v of Object.values(plan.walls)) {
    if (v.id === wallId) continue
    const vlen = Math.hypot(v.b.x - v.a.x, v.b.y - v.a.y) || 1
    const vx = (v.b.x - v.a.x) / vlen
    const vy = (v.b.y - v.a.y) / vlen
    const denom = ux * vy - uy * vx
    if (Math.abs(denom) > 0.2) {
      // crossing wall: intersect the two centerlines (covers T-joints from
      // either side, X crossings and corners); the face cuts our centerline
      // at half the crossing wall's thickness, widened by its slant
      const rx = v.a.x - w.a.x
      const ry = v.a.y - w.a.y
      const t = (rx * vy - ry * vx) / denom
      const s = (rx * uy - ry * ux) / denom
      if (t < -20 || t > len + 20 || s < -20 || s > vlen + 20) continue
      bound(t, v.thickness / 2 / Math.abs(denom))
    } else {
      // (near-)parallel wall: a collinear continuation bounds at the seam
      for (const p of [v.a, v.b]) {
        const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy
        const perp = Math.abs((p.x - w.a.x) * -uy + (p.y - w.a.y) * ux)
        if (t < -20 || t > len + 20) continue
        if (perp > w.thickness / 2 + v.thickness / 2 + 20) continue
        bound(t, 0)
      }
    }
  }
  return [lo, hi]
}
