import type { FloorPlan, Furniture, Point } from '../types/model'

const rad = (deg: number) => (deg * Math.PI) / 180
const snap10 = (v: number) => Math.round(v / 10) * 10

type Pose = Pick<Furniture, 'center' | 'width' | 'depth' | 'rotation'>

/** World corners of a furniture rectangle (clockwise from back-left). */
export function furnitureCorners(f: Pose): Point[] {
  const c = Math.cos(rad(f.rotation))
  const s = Math.sin(rad(f.rotation))
  const hw = f.width / 2
  const hd = f.depth / 2
  const local: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  return local.map(([x, y]) => ({
    x: f.center.x + x * c - y * s,
    y: f.center.y + x * s + y * c,
  }))
}

/** Is the world point inside the furniture rectangle (+margin, mm)? */
export function furnitureHit(p: Point, f: Pose, margin = 0): boolean {
  const c = Math.cos(rad(f.rotation))
  const s = Math.sin(rad(f.rotation))
  const dx = p.x - f.center.x
  const dy = p.y - f.center.y
  const lx = dx * c + dy * s
  const ly = -dx * s + dy * c
  return (
    Math.abs(lx) <= f.width / 2 + margin && Math.abs(ly) <= f.depth / 2 + margin
  )
}

/** Furniture pieces with an edge resting on a face of wall `w` (within
 *  `tol` mm) — these follow along when the wall is moved. */
export function furnitureOnWall(
  plan: FloorPlan,
  w: { a: Point; b: Point; thickness: number; transparent?: boolean },
  tol = 20,
): Furniture[] {
  if (w.transparent) return []
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
  if (len < 1) return []
  const ux = (w.b.x - w.a.x) / len
  const uy = (w.b.y - w.a.y) / len
  const nx = -uy
  const ny = ux
  const half = w.thickness / 2
  const out: Furniture[] = []
  for (const f of Object.values(plan.furniture ?? {})) {
    const cs = furnitureCorners(f)
    const cd = (f.center.x - w.a.x) * nx + (f.center.y - w.a.y) * ny
    for (let i = 0; i < 4; i++) {
      const a = cs[i]
      const b = cs[(i + 1) % 4]
      const el = Math.hypot(b.x - a.x, b.y - a.y) || 1
      if (Math.abs(((b.x - a.x) * uy - (b.y - a.y) * ux) / el) > 0.05) continue // not parallel
      const da = (a.x - w.a.x) * nx + (a.y - w.a.y) * ny
      if (Math.abs(Math.abs(da) - half) > tol) continue // not on a face
      if (Math.sign(da) !== Math.sign(cd) || Math.abs(cd) < Math.abs(da) - 1)
        continue // the edge must lie between the wall and the centre
      const ta = (a.x - w.a.x) * ux + (a.y - w.a.y) * uy
      const tb = (b.x - w.a.x) * ux + (b.y - w.a.y) * uy
      if (Math.max(ta, tb) < 0 || Math.min(ta, tb) > len) continue // no overlap
      out.push(f)
      break
    }
  }
  return out
}

/** How close (mm) the furniture back must be to a wall face to snap. */
const SNAP_RANGE = 200

/** Snap a furniture pose: when the back edge comes near a wall face, align
 *  the rotation to the wall and sit the back flush on the face (sliding
 *  along the wall in 10mm steps). While back-snapped, a side edge nearing a
 *  roughly perpendicular wall slides along to meet it (corner placement).
 *  Away from walls, the center snaps to the 10mm grid, rotation untouched. */
export function snapFurniture(
  plan: FloorPlan,
  center: Point,
  width: number,
  depth: number,
  rotation: number,
): { center: Point; rotation: number; snapped: boolean } {
  let best: {
    center: Point
    rotation: number
    gap: number
    wallId: string
    u: Point
  } | null = null
  for (const w of Object.values(plan.walls)) {
    if (w.transparent) continue // virtual walls don't block furniture
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (len < 1) continue
    const ux = (w.b.x - w.a.x) / len
    const uy = (w.b.y - w.a.y) / len
    const nx = -uy
    const ny = ux
    const proj = (center.x - w.a.x) * ux + (center.y - w.a.y) * uy
    if (proj < 0 || proj > len) continue
    const sdist = (center.x - w.a.x) * nx + (center.y - w.a.y) * ny
    const side = sdist >= 0 ? 1 : -1
    const want = side * (w.thickness / 2 + depth / 2) // center, back flush
    const gap = Math.abs(sdist - want)
    if (gap > SNAP_RANGE) continue
    if (!best || gap < best.gap) {
      const p = snap10(proj)
      best = {
        center: { x: w.a.x + ux * p + nx * want, y: w.a.y + uy * p + ny * want },
        // back (local -y) faces the wall
        rotation: (Math.atan2(side * uy, side * ux) * 180) / Math.PI,
        gap,
        wallId: w.id,
        u: { x: ux, y: uy },
      }
    }
  }
  if (best) {
    // corner snap: slide along the primary wall until a side edge meets the
    // nearest (roughly perpendicular) wall face — only the face on the
    // furniture's side, so it never jumps across a wall
    const u = best.u
    let c = best.center
    let slide: number | null = null
    for (const w2 of Object.values(plan.walls)) {
      if (w2.id === best.wallId || w2.transparent) continue
      const len2 = Math.hypot(w2.b.x - w2.a.x, w2.b.y - w2.a.y)
      if (len2 < 1) continue
      const u2x = (w2.b.x - w2.a.x) / len2
      const u2y = (w2.b.y - w2.a.y) / len2
      const n2x = -u2y
      const n2y = u2x
      const dot = u.x * n2x + u.y * n2y // how much sliding moves toward w2
      if (Math.abs(dot) < 0.7) continue // not blocking the slide direction
      const csd = (c.x - w2.a.x) * n2x + (c.y - w2.a.y) * n2y
      const face = (csd >= 0 ? 1 : -1) * (w2.thickness / 2)
      for (const s of [1, -1]) {
        const ex = c.x + u.x * s * (width / 2)
        const ey = c.y + u.y * s * (width / 2)
        const so = (ex - w2.a.x) * n2x + (ey - w2.a.y) * n2y
        const d = (face - so) / dot
        if (Math.abs(d) > SNAP_RANGE) continue
        // corrected edge must land within w2's span
        const px = ex + u.x * d
        const py = ey + u.y * d
        const sp = (px - w2.a.x) * u2x + (py - w2.a.y) * u2y
        if (sp < 0 || sp > len2) continue
        if (slide === null || Math.abs(d) < Math.abs(slide)) slide = d
      }
    }
    if (slide !== null) c = { x: c.x + u.x * slide, y: c.y + u.y * slide }
    return { center: c, rotation: best.rotation, snapped: true }
  }

  // no back-snap: snap whichever edge (in the CURRENT orientation, without
  // rotating) comes near a facing wall face; two roughly perpendicular
  // corrections may combine (corner)
  const rad0 = (rotation * Math.PI) / 180
  const axx = Math.cos(rad0)
  const axy = Math.sin(rad0)
  const edges = [
    { dx: axx, dy: axy, half: width / 2, cx: -axy, cy: axx, cross: depth / 2 },
    { dx: -axx, dy: -axy, half: width / 2, cx: -axy, cy: axx, cross: depth / 2 },
    { dx: -axy, dy: axx, half: depth / 2, cx: axx, cy: axy, cross: width / 2 },
    { dx: axy, dy: -axx, half: depth / 2, cx: axx, cy: axy, cross: width / 2 },
  ]
  const cands: { dx: number; dy: number; abs: number; nx: number; ny: number }[] =
    []
  for (const w2 of Object.values(plan.walls)) {
    if (w2.transparent) continue
    const len2 = Math.hypot(w2.b.x - w2.a.x, w2.b.y - w2.a.y)
    if (len2 < 1) continue
    const u2x = (w2.b.x - w2.a.x) / len2
    const u2y = (w2.b.y - w2.a.y) / len2
    const n2x = -u2y
    const n2y = u2x
    const csd = (center.x - w2.a.x) * n2x + (center.y - w2.a.y) * n2y
    const side = csd >= 0 ? 1 : -1
    const target = side * (w2.thickness / 2) // the face on the furniture's side
    for (const e of edges) {
      // the edge must face the wall (be roughly parallel to it)
      if ((e.dx * n2x + e.dy * n2y) * side > -0.7) continue
      const ex = center.x + e.dx * e.half
      const ey = center.y + e.dy * e.half
      const so = (ex - w2.a.x) * n2x + (ey - w2.a.y) * n2y
      const delta = target - so
      if (Math.abs(delta) > SNAP_RANGE) continue
      // the corrected edge must overlap the wall's span
      const px = ex + n2x * delta
      const py = ey + n2y * delta
      const s1 = (px + e.cx * e.cross - w2.a.x) * u2x + (py + e.cy * e.cross - w2.a.y) * u2y
      const s2 = (px - e.cx * e.cross - w2.a.x) * u2x + (py - e.cy * e.cross - w2.a.y) * u2y
      if (Math.max(s1, s2) < 0 || Math.min(s1, s2) > len2) continue
      cands.push({
        dx: n2x * delta,
        dy: n2y * delta,
        abs: Math.abs(delta),
        nx: n2x,
        ny: n2y,
      })
    }
  }
  if (cands.length) {
    cands.sort((a, b) => a.abs - b.abs)
    const first = cands[0]
    let cx = center.x + first.dx
    let cy = center.y + first.dy
    const second = cands.find(
      (cd) => Math.abs(cd.nx * first.nx + cd.ny * first.ny) < 0.5,
    )
    if (second) {
      cx += second.dx
      cy += second.dy
    }
    return { center: { x: cx, y: cy }, rotation, snapped: true }
  }

  return {
    center: { x: snap10(center.x), y: snap10(center.y) },
    rotation,
    snapped: false,
  }
}

/** Distance from the `origins` points along `dir` (unit) to the nearest wall
 *  face in front of them — Infinity when nothing is hit. Used to stop a
 *  furniture resize at the opposing wall. */
export function extentToWall(
  plan: FloorPlan,
  origins: Point[],
  dir: Point,
): number {
  let best = Infinity
  for (const w of Object.values(plan.walls)) {
    if (w.transparent) continue // virtual walls don't limit resizing
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (len < 1) continue
    const ux = (w.b.x - w.a.x) / len
    const uy = (w.b.y - w.a.y) / len
    const nx = -uy
    const ny = ux
    const denom = dir.x * nx + dir.y * ny
    if (Math.abs(denom) < 1e-6) continue // moving parallel to this wall
    const half = w.thickness / 2
    for (const sgn of [1, -1]) {
      for (const o of origins) {
        const so = (o.x - w.a.x) * nx + (o.y - w.a.y) * ny
        const t = (sgn * half - so) / denom
        if (t < -0.5) continue // behind the origin (float-noise tolerant)
        const s = (o.x + dir.x * t - w.a.x) * ux + (o.y + dir.y * t - w.a.y) * uy
        if (s < 0 || s > len) continue
        best = Math.min(best, Math.max(0, t))
      }
    }
  }
  return best
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Axis-aligned bounding box of several furniture pieces (world). */
export function furnitureBBox(items: Pose[]): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of items) {
    for (const c of furnitureCorners(f)) {
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x)
      maxY = Math.max(maxY, c.y)
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** Translation correction snapping a group bounding box to nearby wall faces
 *  (the nearest face, plus a perpendicular one for corner snaps); away from
 *  walls the box min-corner snaps to the 10mm grid. */
export function snapBBox(plan: FloorPlan, box: BBox): Point {
  const corners: Point[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ]
  const cands: { dx: number; dy: number; abs: number; nx: number; ny: number }[] =
    []
  for (const w of Object.values(plan.walls)) {
    if (w.transparent) continue // virtual walls don't block furniture
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (len < 1) continue
    const ux = (w.b.x - w.a.x) / len
    const uy = (w.b.y - w.a.y) / len
    const nx = -uy
    const ny = ux
    let tMin = Infinity
    let tMax = -Infinity
    let sMin = Infinity
    let sMax = -Infinity
    for (const c of corners) {
      const t = (c.x - w.a.x) * ux + (c.y - w.a.y) * uy
      const s = (c.x - w.a.x) * nx + (c.y - w.a.y) * ny
      tMin = Math.min(tMin, t)
      tMax = Math.max(tMax, t)
      sMin = Math.min(sMin, s)
      sMax = Math.max(sMax, s)
    }
    if (tMax < 0 || tMin > len) continue // no overlap along the wall
    const half = w.thickness / 2
    // box on the +n side of the wall, near face +half
    let ds = half - sMin
    if (Math.abs(ds) <= SNAP_RANGE && sMax >= half) {
      cands.push({ dx: nx * ds, dy: ny * ds, abs: Math.abs(ds), nx, ny })
    }
    // box on the -n side, near face -half
    ds = -half - sMax
    if (Math.abs(ds) <= SNAP_RANGE && sMin <= -half) {
      cands.push({ dx: nx * ds, dy: ny * ds, abs: Math.abs(ds), nx, ny })
    }
  }
  if (!cands.length) {
    return {
      x: snap10(box.minX) - box.minX,
      y: snap10(box.minY) - box.minY,
    }
  }
  cands.sort((a, b) => a.abs - b.abs)
  const first = cands[0]
  let cx = first.dx
  let cy = first.dy
  const second = cands.find(
    (c) => Math.abs(c.nx * first.nx + c.ny * first.ny) < 0.7,
  )
  if (second) {
    cx += second.dx
    cy += second.dy
  }
  return { x: cx, y: cy }
}
