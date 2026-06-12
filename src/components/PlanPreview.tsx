import type { FloorPlan } from '../types/model'
import { doorScreenGeometry } from '../geometry/door'
import { windowScreenGeometry } from '../geometry/window'
import { furnitureBBox } from '../geometry/furniture'
import { detectRooms, roomExcluded } from '../geometry/rooms'

/** Identity viewport: the SVG viewBox is in world mm, so "screen" == world. */
const VP = { scale: 1, offsetX: 0, offsetY: 0 }

const toPoints = (flat: number[]) => {
  const out: string[] = []
  for (let i = 0; i < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`)
  return out.join(' ')
}

/** Small SVG thumbnail of a plan: walls, door/window symbols and furniture. */
export default function PlanPreview({ plan }: { plan: FloorPlan | null }) {
  const walls = plan ? Object.values(plan.walls) : []
  const furniture = plan ? Object.values(plan.furniture ?? {}) : []
  if (!walls.length && !furniture.length) {
    return <div className="preview preview-empty">빈 도면</div>
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  const fb = furnitureBBox(furniture)
  if (fb) {
    minX = Math.min(minX, fb.minX)
    minY = Math.min(minY, fb.minY)
    maxX = Math.max(maxX, fb.maxX)
    maxY = Math.max(maxY, fb.maxY)
  }
  const pad = 1000 // door swings reach up to a door width outside the wall
  return (
    <div className="preview">
      <svg
        viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* room fills, white like the canvas (excluded rooms keep the bg) */}
        {plan &&
          detectRooms(plan).map((r) =>
            roomExcluded(plan, r.polygon) ? null : (
              <polygon
                key={r.id}
                points={r.polygon.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="#ffffff"
              />
            ),
          )}
        {walls.map((w) => {
          if (w.transparent) {
            // virtual wall: dashed body outline only
            const dx = w.b.x - w.a.x
            const dy = w.b.y - w.a.y
            const len = Math.hypot(dx, dy) || 1
            const h = w.thickness / 2
            const ux = (dx / len) * h
            const uy = (dy / len) * h
            const pts = [
              `${w.a.x - ux - uy},${w.a.y - uy + ux}`,
              `${w.b.x + ux - uy},${w.b.y + uy + ux}`,
              `${w.b.x + ux + uy},${w.b.y + uy - ux}`,
              `${w.a.x - ux + uy},${w.a.y - uy - ux}`,
            ].join(' ')
            return (
              <polygon
                key={w.id}
                points={pts}
                fill="none"
                stroke="#2f333b"
                opacity={0.35}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="5 4"
              />
            )
          }
          return (
            <line
              key={w.id}
              x1={w.a.x}
              y1={w.a.y}
              x2={w.b.x}
              y2={w.b.y}
              stroke="#2f333b"
              strokeWidth={w.thickness}
              strokeLinecap="square"
            />
          )
        })}
        {plan &&
          Object.values(plan.openings).map((op) => {
            const w = plan.walls[op.wallId]
            if (!w) return null
            const g =
              op.type === 'window'
                ? windowScreenGeometry(w, op, VP)
                : doorScreenGeometry(w, op, VP)
            return (
              <g key={op.id}>
                <line
                  x1={g.gap[0].x}
                  y1={g.gap[0].y}
                  x2={g.gap[1].x}
                  y2={g.gap[1].y}
                  stroke="#ffffff"
                  strokeWidth={w.thickness + 2}
                  strokeLinecap="butt"
                />
                {g.strokes.map((st, i) => (
                  <polyline
                    key={i}
                    points={toPoints(st.points)}
                    fill="none"
                    stroke={st.dash ? '#b8bdc8' : '#48597a'}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray={st.dash ? '4 3' : undefined}
                  />
                ))}
              </g>
            )
          })}
        {furniture.map((f) => (
          <g
            key={f.id}
            transform={`translate(${f.center.x} ${f.center.y}) rotate(${f.rotation}) scale(${f.flipH ? -1 : 1} ${f.flipV ? -1 : 1})`}
          >
            <rect
              x={-f.width / 2}
              y={-f.depth / 2}
              width={f.width}
              height={f.depth}
              fill="#ffffff"
              stroke="#5a6472"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
    </div>
  )
}
