import type { OpeningStyle, Point, Wall } from '../types/model'
import { worldToScreen, type Viewport } from './viewport'
import type { DoorScreenGeometry, DoorStroke } from './door'

export interface WindowSpec {
  position: number
  width: number
  flipH?: boolean
  flipV?: boolean
  style?: OpeningStyle
}

const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y })
const mul = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k })
const mid = (p: Point, q: Point): Point => ({
  x: (p.x + q.x) / 2,
  y: (p.y + q.y) / 2,
})

/** Window symbol geometry in screen space (reuses the door geometry shape). */
export function windowScreenGeometry(
  w: Wall,
  op: WindowSpec,
  vp: Viewport,
): DoorScreenGeometry {
  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const len = Math.hypot(dx, dy) || 1
  const u = { x: dx / len, y: dy / len }
  const sv = op.flipV ? -1 : 1
  const n = { x: -u.y * sv, y: u.x * sv }
  const hw = op.width / 2
  const th = w.thickness / 2
  const lo = add(w.a, mul(u, op.position - hw))
  const hi = add(w.a, mul(u, op.position + hw))
  const c1 = op.flipH ? hi : lo
  const c2 = op.flipH ? lo : hi
  const W = (p: Point) => worldToScreen(p, vp)
  const seg = (a: Point, b: Point, dash?: boolean): DoorStroke => {
    const sa = W(a)
    const sb = W(b)
    return { points: [sa.x, sa.y, sb.x, sb.y], dash }
  }

  const style = op.style ?? 'sliding'
  let region: number[] | undefined
  // frame: the two wall faces across the opening + a centre glass line;
  // inset by half the stroke width so the lines stay within the wall body
  const tf = Math.max(0, th - 0.7 / vp.scale)
  const strokes: DoorStroke[] = [
    seg(add(lo, mul(n, tf)), add(hi, mul(n, tf))),
    seg(add(lo, mul(n, -tf)), add(hi, mul(n, -tf))),
  ]

  if (style === 'fix') {
    strokes.push(seg(lo, hi))
  } else if (style === 'hung') {
    // double sash: two glass lines
    strokes.push(seg(add(lo, mul(n, th * 0.35)), add(hi, mul(n, th * 0.35))))
    strokes.push(seg(add(lo, mul(n, -th * 0.35)), add(hi, mul(n, -th * 0.35))))
  } else if (style === 'sliding') {
    const d = op.flipH ? mul(u, -1) : u // c1 → c2 along the wall
    const oA = mul(n, -40)
    const oB = mul(n, 40)
    if (op.width > 1800) {
      // wide window: three sashes on alternating tracks
      const L = op.width / 3 + 55 // ~80mm overlap between neighbours
      const at = (t: number) => add(c1, mul(d, t))
      strokes.push(seg(add(at(0), oA), add(at(L), oA)))
      strokes.push(
        seg(
          add(at((op.width - L) / 2), oB),
          add(at((op.width + L) / 2), oB),
        ),
      )
      strokes.push(seg(add(at(op.width - L), oA), add(at(op.width), oA)))
      // 180mm cross ticks through both overlaps
      for (const t of [(op.width + L) / 4, (3 * op.width - L) / 4]) {
        const ctr = at(t)
        strokes.push(seg(add(ctr, mul(n, -90)), add(ctr, mul(n, 90))))
      }
    } else {
      // two overlapping sashes, same form as the sliding (미서기) door;
      // fixed 80mm gap and fixed 80mm overlap regardless of size
      const q = op.width / 2 + 40
      strokes.push(seg(add(c1, oA), add(add(c1, mul(d, q)), oA)))
      strokes.push(seg(add(c2, oB), add(add(c2, mul(d, -q)), oB)))
      // 180mm centerline through the overlap, across the wall
      const ctr = mid(c1, c2)
      strokes.push(seg(add(ctr, mul(n, -90)), add(ctr, mul(n, 90))))
    }
  } else if (style === 'awning') {
    // top-hinge tilt: a shallow tent toward the swing side
    strokes.push(seg(lo, hi))
    const apex = add(mid(lo, hi), mul(n, op.width * 0.35))
    strokes.push(seg(lo, apex))
    strokes.push(seg(hi, apex))
    const sLo = W(lo)
    const sHi = W(hi)
    const sApex = W(apex)
    region = [sLo.x, sLo.y, sApex.x, sApex.y, sHi.x, sHi.y] // tent triangle
  } else {
    // turn (casement): glass + leaf opened 30° + swing arc
    strokes.push(seg(lo, hi))
    const vd = mul({ x: c2.x - c1.x, y: c2.y - c1.y }, 1 / (op.width || 1))
    const OPEN = Math.PI / 6 // 30°
    const leaf = add(
      c1,
      mul(add(mul(vd, Math.cos(OPEN)), mul(n, Math.sin(OPEN))), op.width),
    )
    strokes.push(seg(c1, leaf))
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
  }

  return {
    gap: [W(lo), W(hi)],
    wallPx: Math.max(2, w.thickness * vp.scale),
    strokes,
    region,
  }
}
