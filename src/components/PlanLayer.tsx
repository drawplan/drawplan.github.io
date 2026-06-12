import { useMemo } from 'react'
import { Arrow, Circle, Group, Line, Rect, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { usePlanStore } from '../store/usePlanStore'
import { ROOM_KIND_LABELS } from '../types/model'
import { worldToScreen, type Viewport } from '../geometry/viewport'
import {
  detectRooms,
  formatArea,
  arrangementVertices,
  pointInPolygon,
  roomExcluded,
} from '../geometry/rooms'
import { detectSeams } from '../geometry/seams'
import { computeProbeDimensions, type Dimension } from '../geometry/dimension'
import { doorScreenGeometry } from '../geometry/door'
import { windowScreenGeometry } from '../geometry/window'
import { computeAutoDimensions } from '../geometry/autodim'
import { wallSegmentFacesAt } from '../geometry/segment'
import type { Point, WallEnd } from '../types/model'

export type EditDimensionFn = (dim: Dimension, screen: Point) => void
export type EditOpeningDimFn = (
  openingId: string,
  side: 'low' | 'high',
  dist: number,
  screen: Point,
) => void
export type EndpointDragFn = (
  wallId: string,
  end: WallEnd,
  phase: 'start' | 'move' | 'end',
  e: KonvaEventObject<DragEvent>,
) => void

export const WALL_NAME_PREFIX = 'wall:'

interface Props {
  viewport: Viewport
  onEndpointDrag: EndpointDragFn
}

const DIM_COLOR = '#e07c0a' // same look as opening/clearance dimensions

/** White fill inside every detected room; rooms excluded from the total
 *  area keep the canvas background colour instead.
 *  Rendered separately so it can sit below the furniture. */
export function RoomFills({ viewport }: { viewport: Viewport }) {
  const plan = usePlanStore((s) => s.plan)
  const rooms = useMemo(() => detectRooms(plan), [plan])
  return (
    <>
      {rooms.map((r) => (
        <Line
          key={r.id}
          points={r.polygon.flatMap((p) => {
            const s = worldToScreen(p, viewport)
            return [s.x, s.y]
          })}
          closed
          fill={roomExcluded(plan, r.polygon) ? '#e9ecf1' : '#ffffff'}
          listening={false}
        />
      ))}
    </>
  )
}

/** White fill of the opening-symbol regions outside the wall (door swing
 *  sector, awning tent …). Rendered below the furniture so it doesn't hide
 *  pieces standing in the swing area; the symbol strokes stay on top. */
export function OpeningRegions({ viewport }: { viewport: Viewport }) {
  const plan = usePlanStore((s) => s.plan)
  return (
    <>
      {Object.values(plan.openings).map((op) => {
        const w = plan.walls[op.wallId]
        if (!w) return null
        const g =
          op.type === 'window'
            ? windowScreenGeometry(w, op, viewport)
            : doorScreenGeometry(w, op, viewport)
        if (!g.region) return null
        return (
          <Line
            key={op.id}
            points={g.region}
            closed
            fill="#ffffff"
            listening={false}
          />
        )
      })}
    </>
  )
}

/** Room name/area labels + picked-room highlight — rendered above the
 *  furniture so labels never disappear under a large piece. */
export function RoomAnnotations({ viewport }: { viewport: Viewport }) {
  const plan = usePlanStore((s) => s.plan)
  const roomPick = usePlanStore((s) => s.roomPick)
  const rooms = useMemo(() => detectRooms(plan), [plan])
  const pickedRoom = useMemo(
    () => (roomPick ? rooms.find((r) => pointInPolygon(roomPick, r.polygon)) : null),
    [roomPick, rooms],
  )
  return (
    <>
      {/* the clicked room only: highlight + area */}
      {pickedRoom &&
        (() => {
          const flat = pickedRoom.polygon.flatMap((p) => {
            const s = worldToScreen(p, viewport)
            return [s.x, s.y]
          })
          const c = worldToScreen(pickedRoom.labelPoint, viewport)
          // a labeled room keeps its name in place; the area goes below it
          const labeled = Object.values(plan.rooms ?? {}).some((l) =>
            pointInPolygon(l.point, pickedRoom.polygon),
          )
          return (
            <Group listening={false}>
              <Line points={flat} closed fill="rgba(79,140,255,0.18)" />
              <Text
                x={c.x - 60}
                y={labeled ? c.y + 10 : c.y - 9}
                width={120}
                align="center"
                text={formatArea(pickedRoom.area)}
                fontSize={14}
                fontStyle="bold"
                fill="#2f5bb0"
              />
            </Group>
          )
        })()}

      {/* room kind labels (rooms left undefined show nothing) */}
      {rooms.map((r) => {
        const label = Object.values(plan.rooms ?? {}).find((l) =>
          pointInPolygon(l.point, r.polygon),
        )
        if (!label || !label.kind) return null // kind-less labels carry flags only
        const c = worldToScreen(r.labelPoint, viewport)
        const text =
          label.kind === 'etc' ? label.name || '기타' : ROOM_KIND_LABELS[label.kind]
        return (
          <Text
            key={label.id}
            x={c.x - 80}
            y={c.y - 8}
            width={160}
            align="center"
            text={text}
            fontSize={14}
            fontStyle="bold"
            fill="#6a7280"
            listening={false}
          />
        )
      })}
    </>
  )
}

/** All measurement arrows/labels — auto dimension chains, opening width
 *  texts, probe arrows and selected-opening distances. Rendered as the top
 *  layer so furniture never hides them. */
export function DimensionLayer({
  viewport,
  onEditDimension,
  onEditOpeningDim,
}: {
  viewport: Viewport
  onEditDimension: EditDimensionFn
  onEditOpeningDim: EditOpeningDimFn
}) {
  const plan = usePlanStore((s) => s.plan)
  const showDims = usePlanStore((s) => s.showDims)
  const autoDims = useMemo(
    () => (showDims ? computeAutoDimensions(plan) : []),
    [showDims, plan],
  )
  return (
    <>
      {/* opening widths as plain text, away from the swing side */}
      {showDims &&
        Object.values(plan.openings).map((op) => {
          const w = plan.walls[op.wallId]
          if (!w) return null
          const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
          const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
          const sv = op.flipV ? -1 : 1
          const o = w.thickness / 2 + 230
          const p = worldToScreen(
            {
              x: w.a.x + u.x * op.position + u.y * sv * o,
              y: w.a.y + u.y * op.position - u.x * sv * o,
            },
            viewport,
          )
          return (
            <Text
              key={op.id}
              x={p.x - 40}
              y={p.y - 6}
              width={80}
              align="center"
              text={`${Math.round(op.width)}`}
              fontSize={12}
              fill="#384154"
              listening={false}
            />
          )
        })}

      {/* auto dimension chains along the exterior, 2 m outside the bbox */}
      {autoDims.map((d, di) => {
        const last = d.ticks.length - 1
        const wpt = (a: number, b: number) =>
          worldToScreen(
            d.axis === 'h' ? { x: a, y: b } : { x: b, y: a },
            viewport,
          )
        const e0 = wpt(d.ticks[0], d.line)
        const e1 = wpt(d.ticks[last], d.line)
        return (
          <Group key={`dim${di}`} listening={false}>
            <Line points={[e0.x, e0.y, e1.x, e1.y]} stroke="#4a5568" strokeWidth={1} />
            {d.ticks.map((t, i) => {
              const a = wpt(t, d.edge) // witness start (bbox edge)
              const b = wpt(t, d.line) // on the dim line
              return (
                <Group key={i}>
                  <Line
                    points={[a.x, a.y, b.x, b.y]}
                    stroke="#9aa3b2"
                    strokeWidth={0.5}
                    dash={[3, 3]}
                  />
                  <Line
                    points={
                      d.axis === 'h'
                        ? [b.x, b.y - 4, b.x, b.y + 4]
                        : [b.x - 4, b.y, b.x + 4, b.y]
                    }
                    stroke="#4a5568"
                    strokeWidth={1}
                  />
                </Group>
              )
            })}
            {d.ticks.slice(0, last).map((t, i) => {
              const mid = (t + d.ticks[i + 1]) / 2
              const m = wpt(mid, d.line)
              const label = `${Math.round(d.ticks[i + 1] - t)}`
              const outward = Math.sign(d.line - d.edge) // -1 top/left, +1 bottom/right
              if (d.axis === 'h') {
                return (
                  <Text
                    key={`l${i}`}
                    x={m.x - 40}
                    y={outward >= 0 ? m.y - 16 : m.y + 4}
                    width={80}
                    align="center"
                    text={label}
                    fontSize={12}
                    fill="#384154"
                  />
                )
              }
              return outward < 0 ? (
                <Text
                  key={`l${i}`}
                  x={m.x - 84}
                  y={m.y - 7}
                  width={78}
                  align="right"
                  text={label}
                  fontSize={12}
                  fill="#384154"
                />
              ) : (
                <Text
                  key={`l${i}`}
                  x={m.x + 6}
                  y={m.y - 7}
                  width={78}
                  align="left"
                  text={label}
                  fontSize={12}
                  fill="#384154"
                />
              )
            })}
          </Group>
        )
      })}

      {/* dimension arrows (drawn on top so the labels are clickable) */}
      <Dimensions viewport={viewport} onEdit={onEditDimension} />

      {/* selected opening: distances to its wall-segment ends */}
      <OpeningDims viewport={viewport} onEdit={onEditOpeningDim} />
    </>
  )
}

/** Renders rooms, walls, seams, dimension arrows and the selected wall's
 *  endpoint handles. Plain wall vertices are not shown. */
export default function PlanLayer({ viewport, onEndpointDrag }: Props) {
  const plan = usePlanStore((s) => s.plan)
  const tool = usePlanStore((s) => s.tool)
  const selection = usePlanStore((s) => s.selection)
  const selectedOpening = usePlanStore((s) => s.selectedOpening)
  const debug = usePlanStore((s) => s.debug)

  const selectMode = tool === 'select'
  const seams = useMemo(() => detectSeams(plan), [plan])
  const debugVerts = useMemo(
    () => (debug ? arrangementVertices(plan) : []),
    [debug, plan],
  )
  // endpoint handles only when exactly one wall is selected
  const selectedWall = selection.length === 1 ? plan.walls[selection[0]] : null
  const selectedSet = useMemo(() => new Set(selection), [selection])

  return (
    <>
      {/* walls — the selected one is drawn last so it sits on top (incl. at
          intersections, so right-click there targets it) */}
      {[...Object.values(plan.walls)]
        .sort(
          (a, b) =>
            (selectedSet.has(a.id) ? 1 : 0) - (selectedSet.has(b.id) ? 1 : 0),
        )
        .map((w) => {
        const pa = worldToScreen(w.a, viewport)
        const pb = worldToScreen(w.b, viewport)
        const px = Math.max(2, w.thickness * viewport.scale)
        const selected = selectedSet.has(w.id)
        if (w.transparent) {
          // virtual wall: dashed body outline + an invisible hit line so it
          // still selects/drags like a normal wall
          const dx = pb.x - pa.x
          const dy = pb.y - pa.y
          const len = Math.hypot(dx, dy) || 1
          const h = px / 2
          const ux = (dx / len) * h
          const uy = (dy / len) * h
          // square-cap extension at both ends, like the solid wall stroke
          const outline = [
            pa.x - ux - uy, pa.y - uy + ux,
            pb.x + ux - uy, pb.y + uy + ux,
            pb.x + ux + uy, pb.y + uy - ux,
            pa.x - ux + uy, pa.y - uy - ux,
          ]
          return (
            <Group key={w.id}>
              <Line
                points={outline}
                closed
                stroke={selected ? '#2f6df0' : '#2f333b'}
                opacity={selected ? 1 : 0.35}
                strokeWidth={selected ? 1.8 : 1}
                dash={[7, 5]}
                listening={false}
              />
              <Line
                name={WALL_NAME_PREFIX + w.id}
                points={[pa.x, pa.y, pb.x, pb.y]}
                stroke="#000000"
                opacity={0}
                strokeWidth={px}
                lineCap="square"
                hitStrokeWidth={Math.max(px, 14)}
                listening={selectMode}
              />
            </Group>
          )
        }
        return (
          <Line
            key={w.id}
            name={WALL_NAME_PREFIX + w.id}
            points={[pa.x, pa.y, pb.x, pb.y]}
            stroke={selected ? '#2f6df0' : '#2f333b'}
            strokeWidth={px}
            lineCap="square"
            hitStrokeWidth={Math.max(px, 14)}
            listening={selectMode}
          />
        )
      })}

      {/* doors: a gap in the wall + leaf + swing arc */}
      {Object.values(plan.openings).map((op) => {
        const w = plan.walls[op.wallId]
        if (!w) return null
        const g =
          op.type === 'window'
            ? windowScreenGeometry(w, op, viewport)
            : doorScreenGeometry(w, op, viewport)
        const sel = op.id === selectedOpening || selectedSet.has(op.id)
        const dc = sel ? '#2f6df0' : '#48597a'
        return (
          <Group key={op.id} listening={false}>
            {/* erase the wall under the opening — white like furniture,
                sky-blue when selected */}
            <Line
              points={[g.gap[0].x, g.gap[0].y, g.gap[1].x, g.gap[1].y]}
              stroke={sel ? '#d7e6ff' : '#ffffff'}
              strokeWidth={g.wallPx + 2}
              lineCap="butt"
            />
            {/* outside-wall region: white fill lives below the furniture (see
                OpeningRegions); only the selection tint draws here on top */}
            {sel && g.region && (
              <Line points={g.region} closed fill="#d7e6ff" />
            )}
            {g.strokes.map((st, i) => (
              <Line
                key={i}
                points={st.points}
                // dashed strokes run inside the wall body (pocket slide-in) —
                // draw them white so they read against the dark wall
                stroke={st.dash ? '#b8bdc8' : dc}
                strokeWidth={sel ? 2 : 1.4}
                dash={st.dash ? [5, 4] : undefined}
              />
            ))}
          </Group>
        )
      })}

      {/* seams between abutting collinear walls — drawn slightly past the wall
          edges so two merged-looking walls stay visibly separate */}
      {seams.map((s, i) => {
        const half = (s.thickness * viewport.scale) / 2 + 3
        const c = worldToScreen(s.point, viewport)
        return (
          <Line
            key={i}
            points={[
              c.x - s.nx * half,
              c.y - s.ny * half,
              c.x + s.nx * half,
              c.y + s.ny * half,
            ]}
            stroke="#f4f5f7"
            strokeWidth={1.5}
            listening={false}
          />
        )
      })}

      {/* endpoint handles of the selected wall */}
      {selectMode &&
        selectedWall &&
        (['a', 'b'] as WallEnd[]).map((end) => {
          const p = worldToScreen(selectedWall[end], viewport)
          return (
            <Circle
              key={end}
              x={p.x}
              y={p.y}
              radius={6}
              fill="#ffffff"
              stroke="#4f8cff"
              strokeWidth={2}
              draggable
              onMouseDown={(e) => {
                e.cancelBubble = true
              }}
              onDragStart={(e) => {
                e.cancelBubble = true
                onEndpointDrag(selectedWall.id, end, 'start', e)
              }}
              onDragMove={(e) => onEndpointDrag(selectedWall.id, end, 'move', e)}
              onDragEnd={(e) => onEndpointDrag(selectedWall.id, end, 'end', e)}
            />
          )
        })}

      {/* debug: room-detection graph vertices.
          red = open end (degree 1, likely a gap) · green = junction (3+) */}
      {debugVerts.map((v, i) => {
        const p = worldToScreen(v.point, viewport)
        const open = v.degree === 1
        return (
          <Circle
            key={i}
            x={p.x}
            y={p.y}
            radius={open ? 7 : 5}
            fill={open ? '#ff4d4d' : v.degree >= 3 ? '#50c88c' : '#888'}
            stroke="#000"
            strokeWidth={1}
            listening={false}
          />
        )
      })}

    </>
  )
}

const ODIM_COLOR = '#e07c0a'

/** Distance arrows from a selected door/window to its wall segment ends. */
function OpeningDims({
  viewport,
  onEdit,
}: {
  viewport: Viewport
  onEdit: EditOpeningDimFn
}) {
  const plan = usePlanStore((s) => s.plan)
  const selectedOpening = usePlanStore((s) => s.selectedOpening)

  const data = useMemo(() => {
    if (!selectedOpening) return null
    const op = plan.openings[selectedOpening]
    if (!op) return null
    const w = plan.walls[op.wallId]
    if (!w) return null
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
    const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
    const n = { x: -u.y, y: u.x }
    const off = w.thickness / 2 + 350
    // measured from the adjoining wall FACES, not their centerlines
    const [lo, hi] = wallSegmentFacesAt(plan, op.wallId, op.position)
    const base = (t: number): Point => ({
      x: w.a.x + u.x * t + n.x * off,
      y: w.a.y + u.y * t + n.y * off,
    })
    // distances measured to the opening's centre
    return [
      { side: 'low' as const, t0: lo, t1: op.position, dist: op.position - lo, base },
      { side: 'high' as const, t0: op.position, t1: hi, dist: hi - op.position, base },
    ].filter((d) => d.dist > 0.5)
  }, [plan, selectedOpening])

  if (!data || !selectedOpening) return null

  return (
    <>
      {data.map((d) => {
        const from = worldToScreen(d.base(d.t0), viewport)
        const to = worldToScreen(d.base(d.t1), viewport)
        const mx = (from.x + to.x) / 2
        const my = (from.y + to.y) / 2
        const label = `${Math.round(d.dist)}`
        const boxW = label.length * 8 + 14
        const setCursor = (e: KonvaEventObject<MouseEvent>, v: string) => {
          const c = e.target.getStage()?.container()
          if (c) c.style.cursor = v
        }
        const bx = mx - boxW / 2
        const by = my - 10
        return (
          <Group
            key={d.side}
            onMouseEnter={(e) => setCursor(e, 'pointer')}
            onMouseLeave={(e) => setCursor(e, '')}
            onMouseDown={(e) => {
              e.cancelBubble = true // don't let Canvas place/deselect on this click
            }}
            onClick={(e) => {
              e.cancelBubble = true
              onEdit(selectedOpening, d.side, d.dist, { x: bx, y: by })
            }}
          >
            <Arrow
              points={[from.x, from.y, to.x, to.y]}
              stroke={ODIM_COLOR}
              fill={ODIM_COLOR}
              strokeWidth={0.75}
              pointerLength={6}
              pointerWidth={5}
              pointerAtBeginning
              pointerAtEnding
              listening={false}
            />
            <Rect
              x={bx}
              y={by}
              width={boxW}
              height={18}
              cornerRadius={4}
              fill="rgba(255,255,255,0.92)"
              stroke={ODIM_COLOR}
              strokeWidth={0.75}
            />
            <Text
              x={bx}
              y={by + 3}
              width={boxW}
              align="center"
              text={label}
              fontSize={12}
              fill={ODIM_COLOR}
            />
          </Group>
        )
      })}
    </>
  )
}

/** Perpendicular dimension arrows for the currently probed wall point. */
function Dimensions({
  viewport,
  onEdit,
}: {
  viewport: Viewport
  onEdit: EditDimensionFn
}) {
  const plan = usePlanStore((s) => s.plan)
  const probe = usePlanStore((s) => s.wallProbe)
  const dims = useMemo(
    () => (probe ? computeProbeDimensions(plan, probe) : []),
    [plan, probe],
  )

  return (
    <>
      {dims.map((d, i) => {
        const from = worldToScreen(d.from, viewport)
        const to = worldToScreen(d.to, viewport)
        const mx = (from.x + to.x) / 2
        const my = (from.y + to.y) / 2
        const label = `${Math.round(d.distance)}`
        const boxW = label.length * 8 + 14
        const boxH = 18
        // centred on the arrow, same as opening/clearance labels
        const bx = mx - boxW / 2
        const by = my - boxH / 2
        const setCursor = (e: KonvaEventObject<MouseEvent>, v: string) => {
          const c = e.target.getStage()?.container()
          if (c) c.style.cursor = v
        }
        return (
          <Group
            key={i}
            onMouseEnter={(e) => setCursor(e, 'pointer')}
            onMouseLeave={(e) => setCursor(e, '')}
            onClick={(e) => {
              e.cancelBubble = true
              onEdit(d, { x: bx, y: by })
            }}
          >
            <Arrow
              points={[from.x, from.y, to.x, to.y]}
              stroke={DIM_COLOR}
              fill={DIM_COLOR}
              strokeWidth={0.75}
              pointerLength={6}
              pointerWidth={5}
              pointerAtBeginning
              pointerAtEnding
              listening={false}
            />
            <Rect
              x={bx}
              y={by}
              width={boxW}
              height={boxH}
              cornerRadius={4}
              fill="rgba(255,255,255,0.92)"
              stroke={DIM_COLOR}
              strokeWidth={0.75}
            />
            <Text
              x={bx}
              y={by + 3}
              width={boxW}
              align="center"
              text={label}
              fontSize={12}
              fill={DIM_COLOR}
              listening={false}
            />
          </Group>
        )
      })}
    </>
  )
}
