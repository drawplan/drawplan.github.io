import type { FloorPlan, Point, Wall } from '../types/model'

export interface Seam {
  point: Point // junction (world mm)
  nx: number // unit normal (perpendicular to the walls)
  ny: number
  thickness: number // wall thickness at the junction (mm)
}

const keyOf = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`

/** Unit direction of a wall pointing away from one of its endpoints. */
function outward(w: Wall, p: Point): Point {
  const other = keyOf(w.a) === keyOf(p) ? w.b : w.a
  const dx = other.x - p.x
  const dy = other.y - p.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/** Junctions where two collinear walls meet end-to-end. A thin perpendicular
 *  tick is drawn there so abutting same-direction walls stay distinguishable. */
export function detectSeams(plan: FloorPlan): Seam[] {
  // group wall endpoints by coincident location (transparent walls have no
  // body fill, so they neither need nor receive seam ticks)
  const groups = new Map<string, { p: Point; walls: Wall[] }>()
  for (const w of Object.values(plan.walls)) {
    if (w.transparent) continue
    for (const p of [w.a, w.b]) {
      const k = keyOf(p)
      if (!groups.has(k)) groups.set(k, { p, walls: [] })
      groups.get(k)!.walls.push(w)
    }
  }

  const seams: Seam[] = []
  for (const { p, walls } of groups.values()) {
    if (walls.length < 2) continue
    // find a collinear (opposite-direction) pair through this point
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const di = outward(walls[i], p)
        const dj = outward(walls[j], p)
        const dot = di.x * dj.x + di.y * dj.y
        if (dot < -0.985) {
          // collinear: draw the seam perpendicular to the wall line
          seams.push({
            point: p,
            nx: -di.y,
            ny: di.x,
            thickness: Math.max(walls[i].thickness, walls[j].thickness),
          })
        }
      }
    }
  }
  return seams
}
