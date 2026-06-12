import type { FloorPlan, Furniture, Point, Wall } from '../types/model'

/** Signed distance to an obstacle the room label must avoid: positive
 *  outside, negative inside. Must be 1-Lipschitz (true distances are). */
export type ObstacleFn = (p: Point) => number

/** Rectangular obstacle (a furniture body) the room label should avoid. */
export type Obstacle = Pick<Furniture, 'center' | 'width' | 'depth' | 'rotation'>

export interface DetectedRoom {
  id: string
  polygon: Point[] // boundary points (world mm)
  area: number // mm²
  centroid: Point // world mm — area centroid
  labelPoint: Point // world mm — label anchor (pole of inaccessibility)
}

const keyOf = (p: Point) => `${Math.round(p.x)},${Math.round(p.y)}`
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
const len = (w: Wall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
const angleBetween = (from: Point, to: Point) =>
  Math.atan2(to.y - from.y, to.x - from.x)

/** Where segments i and j meet, as parameters (ti on i, tj on j), or null.
 *  Covers crossings and T-touches; collinear overlaps are ignored. */
function intersectParams(
  i: Wall,
  j: Wall,
): { ti: number; tj: number } | null {
  const rx = i.b.x - i.a.x
  const ry = i.b.y - i.a.y
  const sx = j.b.x - j.a.x
  const sy = j.b.y - j.a.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null // parallel
  const qpx = j.a.x - i.a.x
  const qpy = j.a.y - i.a.y
  const ti = (qpx * sy - qpy * sx) / denom
  const tj = (qpx * ry - qpy * rx) / denom
  const e = 1e-6
  if (ti < -e || ti > 1 + e || tj < -e || tj > 1 + e) return null
  return { ti, tj }
}

function signedArea(pts: Point[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

function centroidOf(pts: Point[], area: number): Point {
  if (Math.abs(area) < 1) {
    const avg = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), {
      x: 0,
      y: 0,
    })
    return { x: avg.x / pts.length, y: avg.y / pts.length }
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const cross = a.x * b.y - b.x * a.y
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }
  return { x: cx / (6 * area), y: cy / (6 * area) }
}

interface Arrangement {
  point: Map<string, Point>
  adj: Map<string, Set<string>>
}

/** Build the planar graph of wall centrelines, cut at every crossing/touch. */
export function buildArrangement(plan: FloorPlan): Arrangement {
  const walls = Object.values(plan.walls).filter((w) => len(w) > 1)
  const cuts: number[][] = walls.map(() => [0, 1])

  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const r = intersectParams(walls[i], walls[j])
      if (r) {
        cuts[i].push(Math.max(0, Math.min(1, r.ti)))
        cuts[j].push(Math.max(0, Math.min(1, r.tj)))
      }
    }
  }

  const point = new Map<string, Point>()
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }

  walls.forEach((w, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6))].sort(
      (a, b) => a - b,
    )
    for (let k = 0; k < ts.length - 1; k++) {
      const pa = lerp(w.a, w.b, ts[k])
      const pb = lerp(w.a, w.b, ts[k + 1])
      const ka = keyOf(pa)
      const kb = keyOf(pb)
      if (ka === kb) continue
      point.set(ka, pa)
      point.set(kb, pb)
      link(ka, kb)
      link(kb, ka)
    }
  })

  return { point, adj }
}

/** Arrangement vertices with their degree — for debugging room detection.
 *  Degree-1 vertices are open ends (likely gaps that break a room). */
export function arrangementVertices(
  plan: FloorPlan,
): { point: Point; degree: number }[] {
  const { point, adj } = buildArrangement(plan)
  return [...adj].map(([k, set]) => ({ point: point.get(k)!, degree: set.size }))
}

/** Detect rooms as bounded faces of the planar arrangement of wall centrelines.
 *  Walls are cut at every crossing/touch so corners, crossings and T-junctions
 *  all close regions — endpoints need not be exactly coincident. */
export function detectRooms(plan: FloorPlan): DetectedRoom[] {
  const { point, adj } = buildArrangement(plan)
  const swings = doorSwings(plan)

  // neighbours sorted CCW by angle around each vertex
  const sorted = new Map<string, string[]>()
  for (const [k, set] of adj) {
    const p = point.get(k)!
    sorted.set(
      k,
      [...set].sort(
        (x, y) =>
          angleBetween(p, point.get(x)!) - angleBetween(p, point.get(y)!),
      ),
    )
  }

  const nextEdge = (u: string, v: string): [string, string] => {
    const nbrs = sorted.get(v)!
    const i = nbrs.indexOf(u)
    const j = (i - 1 + nbrs.length) % nbrs.length
    return [v, nbrs[j]]
  }

  const visited = new Set<string>()
  const rooms: DetectedRoom[] = []

  for (const [u0, nbrs] of sorted) {
    for (const v0 of nbrs) {
      if (visited.has(`${u0}->${v0}`)) continue
      const loop: string[] = []
      let u = u0
      let v = v0
      let guard = 0
      while (guard++ < 100000) {
        const key = `${u}->${v}`
        if (visited.has(key)) break
        visited.add(key)
        loop.push(u)
        ;[u, v] = nextEdge(u, v)
        if (u === u0 && v === v0) break
      }
      if (loop.length < 3) continue

      const polygon = loop.map((k) => ({ ...point.get(k)! }))
      const area = signedArea(polygon)
      if (area <= 1000) continue // outer face (negative) and slivers dropped

      const centroid = centroidOf(polygon, area)
      // label avoids furniture standing in this room and door swings into it
      const obstacles = [
        ...Object.values(plan.furniture ?? {})
          .filter((f) => pointInPolygon(f.center, polygon))
          .map(rectObstacle),
        ...swings
          .filter((s) => pointInPolygon(s.probe, polygon))
          .map((s) => s.fn),
      ]
      rooms.push({
        id: [...loop].sort().join('|'),
        polygon,
        area,
        centroid,
        labelPoint: poleOfInaccessibility(polygon, centroid, obstacles),
      })
    }
  }

  return rooms
}

export const formatArea = (mm2: number) => `${(mm2 / 1_000_000).toFixed(2)} m²`

/** Is the room flagged "exclude from total area" (via its label)? */
export function roomExcluded(plan: FloorPlan, polygon: Point[]): boolean {
  return Object.values(plan.rooms ?? {}).some(
    (l) => l.excludeArea && pointInPolygon(l.point, polygon),
  )
}

/** Sum of room areas, skipping rooms flagged as excluded. */
export function totalArea(plan: FloorPlan): number {
  return detectRooms(plan).reduce(
    (a, r) => (roomExcluded(plan, r.polygon) ? a : a + r.area),
    0,
  )
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance to the polygon boundary; positive inside, negative outside. */
function signedDist(p: Point, poly: Point[]): number {
  let min = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    min = Math.min(min, segDist(p, poly[j], poly[i]))
  }
  return pointInPolygon(p, poly) ? min : -min
}

/** Signed distance to a rotated rectangle: positive outside, negative inside. */
export function rectObstacle(f: Obstacle): ObstacleFn {
  const rad = (f.rotation * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return (p) => {
    const dx = p.x - f.center.x
    const dy = p.y - f.center.y
    const qx = Math.abs(dx * c + dy * s) - f.width / 2
    const qy = Math.abs(-dx * s + dy * c) - f.depth / 2
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0)
    )
  }
}

/** Signed distance (approx.) to a ≤180° circular sector at `center` between
 *  unit directions `dA` and `dB` — a door's swing region. The max-of-parts
 *  form slightly underestimates outside distance, which is safe here. */
export function sectorObstacle(
  center: Point,
  radius: number,
  dA: Point,
  dB: Point,
): ObstacleFn {
  return (p) => {
    const dx = p.x - center.x
    const dy = p.y - center.y
    return Math.max(
      Math.hypot(dx, dy) - radius,
      -(dx * dA.x + dy * dA.y),
      -(dx * dB.x + dy * dB.y),
    )
  }
}

/** Swing sectors of hinge doors (the quarter circle the leaf sweeps inside a
 *  room). `probe` is a point in the middle of the sector, used to find which
 *  room the door opens into. */
export function doorSwings(
  plan: FloorPlan,
): { fn: ObstacleFn; probe: Point }[] {
  const out: { fn: ObstacleFn; probe: Point }[] = []
  for (const op of Object.values(plan.openings)) {
    if (op.type !== 'door' || (op.style ?? 'hinge') !== 'hinge') continue
    const w = plan.walls[op.wallId]
    if (!w) continue
    const wl = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (wl < 1) continue
    const ux = (w.b.x - w.a.x) / wl
    const uy = (w.b.y - w.a.y) / wl
    const sv = op.flipV ? -1 : 1
    const n = { x: -uy * sv, y: ux * sv } // swing side
    const hw = op.width / 2
    const hinge = {
      x: w.a.x + ux * (op.position + (op.flipH ? hw : -hw)),
      y: w.a.y + uy * (op.position + (op.flipH ? hw : -hw)),
    }
    const dLatch = { x: op.flipH ? -ux : ux, y: op.flipH ? -uy : uy }
    const mid = { x: dLatch.x + n.x, y: dLatch.y + n.y }
    const ml = Math.hypot(mid.x, mid.y) || 1
    out.push({
      fn: sectorObstacle(hinge, op.width, dLatch, n),
      probe: {
        x: hinge.x + (mid.x / ml) * op.width * 0.5,
        y: hinge.y + (mid.y / ml) * op.width * 0.5,
      },
    })
  }
  return out
}

/** The interior point farthest from the boundary AND from any obstacle
 *  (Mapbox polylabel-style grid refinement). Ties keep the seed (centroid),
 *  so empty rectangles label at their exact center; rooms with furniture
 *  label in the widest clear floor area. */
export function poleOfInaccessibility(
  poly: Point[],
  seed: Point,
  obstacles: ObstacleFn[] = [],
): Point {
  const clearance = (p: Point): number => {
    let d = signedDist(p, poly)
    for (const f of obstacles) d = Math.min(d, f(p))
    return d
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const w = maxX - minX
  const h = maxY - minY
  if (w <= 0 || h <= 0) return seed
  const precision = 10 // mm
  // gentle pull toward the seed: among (near-)equal clearances the point
  // closest to the centroid wins, so corridors of tied optima (e.g. the free
  // strip beside a wall-length cabinet) don't label at their far end
  const PULL = 0.05
  const score = (d: number, x: number, y: number) =>
    d - PULL * Math.hypot(x - seed.x, y - seed.y)

  type Cell = { x: number; y: number; half: number; s: number; max: number }
  const mk = (x: number, y: number, half: number): Cell => {
    const d = clearance({ x, y })
    const r = half * Math.SQRT2
    const dist = Math.hypot(x - seed.x, y - seed.y)
    // upper bound of `score` within the cell
    return { x, y, half, s: score(d, x, y), max: d + r - PULL * Math.max(0, dist - r) }
  }
  const cellSize = Math.min(w, h)
  const queue: Cell[] = []
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(mk(x + cellSize / 2, y + cellSize / 2, cellSize / 2))
    }
  }
  let best = mk(seed.x, seed.y, 0)
  while (queue.length) {
    let bi = 0
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].max > queue[bi].max) bi = i
    }
    const c = queue.splice(bi, 1)[0]
    if (c.s > best.s) best = c
    if (c.max - best.s <= precision) continue
    const q = c.half / 2
    queue.push(
      mk(c.x - q, c.y - q, q),
      mk(c.x + q, c.y - q, q),
      mk(c.x - q, c.y + q, q),
      mk(c.x + q, c.y + q, q),
    )
  }
  return { x: best.x, y: best.y }
}

/** Ray-casting point-in-polygon test (world coords). */
export function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}
