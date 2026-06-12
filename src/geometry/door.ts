import type { OpeningStyle, Point, Wall } from '../types/model'
import { worldToScreen, type Viewport } from './viewport'

export interface DoorSpec {
  position: number // mm from wall endpoint a
  width: number // mm
  flipH?: boolean
  flipV?: boolean
  style?: OpeningStyle
}

export interface DoorStroke {
  points: number[] // flat [x,y,...] in screen px
  dash?: boolean
}

export interface DoorScreenGeometry {
  gap: [Point, Point] // opening span (screen px) — erase the wall here
  wallPx: number // wall thickness in px
  strokes: DoorStroke[] // the door symbol
  region?: number[] // closed polygon of the symbol part outside the wall
  // (swing sector, awning tent …) — used for the selection highlight
}

const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y })
const mul = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k })
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/** Door symbol geometry in screen space for a wall + door spec. */
export function doorScreenGeometry(
  w: Wall,
  op: DoorSpec,
  vp: Viewport,
): DoorScreenGeometry {
  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const len = Math.hypot(dx, dy) || 1
  const u = { x: dx / len, y: dy / len } // along wall
  const sv = op.flipV ? -1 : 1
  const n = { x: -u.y * sv, y: u.x * sv } // across wall (swing side)
  const hw = op.width / 2
  const lo = add(w.a, mul(u, op.position - hw))
  const hi = add(w.a, mul(u, op.position + hw))
  const c1 = op.flipH ? hi : lo // hinge / leading jamb
  const c2 = op.flipH ? lo : hi // latch / trailing jamb
  const W = (p: Point) => worldToScreen(p, vp)
  const seg = (a: Point, b: Point, dash?: boolean): DoorStroke => {
    const sa = W(a)
    const sb = W(b)
    return { points: [sa.x, sa.y, sb.x, sb.y], dash }
  }

  const strokes: DoorStroke[] = []
  let region: number[] | undefined
  const style = op.style ?? 'hinge'

  if (style === 'hinge') {
    const leaf = add(c1, mul(n, op.width))
    strokes.push(seg(c1, leaf))
    // swing arc (screen space), center hinge, from latch dir to leaf dir
    const sH = W(c1)
    const sLat = W(c2)
    const sLeaf = W(leaf)
    const r = op.width * vp.scale
    const a0 = Math.atan2(sLat.y - sH.y, sLat.x - sH.x)
    const a1 = Math.atan2(sLeaf.y - sH.y, sLeaf.x - sH.x)
    let sweep = a1 - a0
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    const arc: number[] = []
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (sweep * i) / 12
      arc.push(sH.x + Math.cos(a) * r, sH.y + Math.sin(a) * r)
    }
    strokes.push({ points: arc })
    region = [sH.x, sH.y, ...arc] // swing sector
  } else if (style === 'pocket') {
    // leaf on the wall centerline, sliding into the wall past the hinge jamb;
    // 50mm clearance at the latch jamb and at the pocket's far end
    const into = { x: c1.x - c2.x, y: c1.y - c2.y }
    const il = Math.hypot(into.x, into.y) || 1
    const dir = { x: into.x / il, y: into.y / il }
    strokes.push(seg(add(c2, mul(dir, 50)), c1))
    strokes.push(seg(c1, add(c1, mul(dir, op.width - 50)), true))
  } else if (style === 'sliding') {
    // two overlapping panels, symmetric about the wall centerline;
    // fixed 80mm gap and fixed 80mm overlap regardless of size
    const q = op.width / 2 + 40
    const d = op.flipH ? mul(u, -1) : u // c1 → c2 along the wall
    const oA = mul(n, -40)
    const oB = mul(n, 40)
    strokes.push(seg(add(c1, oA), add(add(c1, mul(d, q)), oA)))
    strokes.push(seg(add(c2, oB), add(add(c2, mul(d, -q)), oB)))
    // 180mm centerline through the overlap, across the wall
    const ctr = lerp(c1, c2, 0.5)
    strokes.push(seg(add(ctr, mul(n, -90)), add(ctr, mul(n, 90))))
  } else {
    // folding (bi-fold): two leaves half-open in a 45° V from the hinge jamb
    const leaf = op.width / 2
    const dvec = {
      x: (c2.x - c1.x) / (op.width || 1),
      y: (c2.y - c1.y) / (op.width || 1),
    }
    const k = Math.SQRT1_2 // cos/sin 45°
    const apex = add(c1, add(mul(dvec, leaf * k), mul(n, leaf * k)))
    const foot = add(c1, mul(dvec, 2 * leaf * k)) // far leaf end on the track
    strokes.push(seg(c1, apex))
    strokes.push(seg(apex, foot))
    const sC = W(c1)
    const sA = W(apex)
    const sF = W(foot)
    region = [sC.x, sC.y, sA.x, sA.y, sF.x, sF.y] // folded-leaves triangle
  }

  return {
    gap: [W(lo), W(hi)],
    wallPx: Math.max(2, w.thickness * vp.scale),
    strokes,
    region,
  }
}
