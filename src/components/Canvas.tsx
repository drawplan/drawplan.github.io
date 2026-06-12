import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Arrow, Circle, Group, Line, Rect, Text } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { usePlanStore, type AlignMode } from '../store/usePlanStore'
import {
  initialViewport,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../geometry/viewport'
import { snap, nearestWall, type SnapResult } from '../geometry/snap'
import { doorScreenGeometry } from '../geometry/door'
import { windowScreenGeometry } from '../geometry/window'
import type { OpeningStyle, OpeningType, RoomKind } from '../types/model'
import { FURNITURE_KIND_LABELS, ROOM_KIND_LABELS } from '../types/model'
import { distance, formatLength, midpoint } from '../geometry/format'
import { detectRooms, pointInPolygon } from '../geometry/rooms'
import { wallSegmentAt, wallSegmentFacesAt } from '../geometry/segment'
import { beginDrag, endDrag, cancelDrag } from '../store/dragHistory'
import { useTabsStore } from '../store/useTabsStore'
import { loadViewport, saveViewport } from '../storage/projects'
import {
  extentToWall,
  furnitureBBox,
  furnitureCorners,
  furnitureHit,
  furnitureOnWall,
  snapBBox,
  snapFurniture,
  type BBox,
} from '../geometry/furniture'
import Grid from './Grid'
import PlanLayer, {
  DimensionLayer,
  OpeningRegions,
  RoomAnnotations,
  RoomFills,
  WALL_NAME_PREFIX,
} from './PlanLayer'
import FurnitureLayer, { FurnitureSymbol } from './FurnitureLayer'
import type { Dimension } from '../geometry/dimension'
import type { FloorPlan, Point, Wall, WallEnd } from '../types/model'

const DIM_MIN_MM = 50
const DIM_MAX_MM = 100_000

/** Openings are placed/dragged in 10mm steps along the wall. */
const snap10 = (v: number) => Math.round(v / 10) * 10

/** Arrow-key nudge vectors (10mm per press). */
const ARROW_DIRS: Record<string, Point> = {
  ArrowLeft: { x: -10, y: 0 },
  ArrowRight: { x: 10, y: 0 },
  ArrowUp: { x: 0, y: -10 },
  ArrowDown: { x: 0, y: 10 },
}

/** Opening orientation from the cursor's side of the wall centerline:
 *  along-wall side picks flipH, across-wall side picks flipV. */
const flipsFor = (world: Point, w: Wall, cpos: number) => {
  const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
  const ux = (w.b.x - w.a.x) / len
  const uy = (w.b.y - w.a.y) / len
  const dx = world.x - (w.a.x + ux * cpos)
  const dy = world.y - (w.a.y + uy * cpos)
  const along = dx * ux + dy * uy
  const across = dx * -uy + dy * ux
  return { flipH: along > 0, flipV: across < 0 }
}

const hintFrom = (s: SnapResult): { point: Point; kind: 'endpoint' | 'wall' } | null =>
  s.atEndpoint
    ? { point: s.point, kind: 'endpoint' }
    : s.onWall
      ? { point: s.point, kind: 'wall' }
      : null

interface Draft {
  start: SnapResult
  end: SnapResult
}

type Mover = { wallId: string; end: WallEnd; base: Point }

interface WallDrag {
  wallId: string
  baseA: Point
  horizontalWall: boolean
  startWorld: Point
  moved: boolean
  movers: Mover[] // endpoints that translate with the wall (corners + T-joints)
  splits: { end: WallEnd; base: Point }[] // joints to bridge on release
  furn: { id: string; base: Point }[] // furniture snapped to the wall
  copy?: boolean // Ctrl+drag: clone on first movement, toggle-select on click
}

const ON_EPS = 1 // mm — how close an endpoint must lie to a wall to be attached

const unitDir = (w: Wall): Point => {
  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/** Is point p on segment a-b (within eps), endpoints included? */
function onSegment(p: Point, a: Point, b: Point, eps: number): boolean {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return false
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)) <= eps
}

/** Ends of `w` where a collinear continuation wall begins — i.e. points where
 *  the wall was split. Walls joined there must stay behind when `w` moves. */
function splitJointEnds(
  plan: FloorPlan,
  w: Wall,
): { end: WallEnd; base: Point }[] {
  const dir = unitDir(w)
  const out: { end: WallEnd; base: Point }[] = []
  for (const end of ['a', 'b'] as WallEnd[]) {
    const p = w[end]
    for (const c of Object.values(plan.walls)) {
      if (c.id === w.id) continue
      const cd = unitDir(c)
      if (Math.abs(dir.x * cd.y - dir.y * cd.x) >= 0.02) continue // not parallel
      if (
        Math.hypot(c.a.x - p.x, c.a.y - p.y) <= ON_EPS ||
        Math.hypot(c.b.x - p.x, c.b.y - p.y) <= ON_EPS
      ) {
        out.push({ end, base: { ...p } })
        break
      }
    }
  }
  return out
}

/** After wall `wallId` has been translated, bridge each split joint it left
 *  behind with a new wall from the old joint to the moved end — the stationary
 *  walls now meet the bridge in a fresh T joint. Call between begin/endDrag. */
function bridgeSplitJoints(
  wallId: string,
  splits: { end: WallEnd; base: Point }[],
) {
  const st = usePlanStore.getState()
  const cur = st.plan.walls[wallId]
  if (!cur) return
  const dir = unitDir(cur)
  for (const s of splits) {
    const p = cur[s.end]
    const dx = p.x - s.base.x
    const dy = p.y - s.base.y
    // only bridge a sideways move; sliding along the wall axis needs no wall
    if (Math.abs(dx * -dir.y + dy * dir.x) <= 0.5) continue
    st.commitWall(s.base, p, cur.kind, cur.transparent)
  }
}

/** Endpoints that should translate when wall `w` is moved: its own two ends,
 *  plus any other (non-collinear) wall endpoint lying on w — corners AND
 *  T-junctions where a wall ends on w's body. Exception: endpoints sitting
 *  exactly on a split joint (where a collinear continuation of w starts) stay
 *  behind with that continuation, so moving one half keeps the T intact. */
function collectMovers(plan: FloorPlan, w: Wall): Mover[] {
  const dir = unitDir(w)
  const out: Mover[] = [
    { wallId: w.id, end: 'a', base: { ...w.a } },
    { wallId: w.id, end: 'b', base: { ...w.b } },
  ]
  const splits = splitJointEnds(plan, w)
  for (const c of Object.values(plan.walls)) {
    if (c.id === w.id) continue
    const cd = unitDir(c)
    if (Math.abs(dir.x * cd.y - dir.y * cd.x) < 0.02) continue // collinear: skip
    for (const end of ['a', 'b'] as WallEnd[]) {
      const p = c[end]
      if (!onSegment(p, w.a, w.b, ON_EPS)) continue
      if (splits.some((s) => Math.hypot(s.base.x - p.x, s.base.y - p.y) <= ON_EPS))
        continue // stays with the collinear continuation
      out.push({ wallId: c.id, end, base: { ...p } })
    }
  }
  return out
}

interface DimEdit {
  dim: Dimension
  screen: Point
  value: string
  warn: string | null
}

const projectOnWall = (p: Point, w: Wall): Point => {
  const abx = w.b.x - w.a.x
  const aby = w.b.y - w.a.y
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return { ...w.a }
  let t = ((p.x - w.a.x) * abx + (p.y - w.a.y) * aby) / len2
  t = Math.max(0, Math.min(1, t))
  return { x: w.a.x + abx * t, y: w.a.y + aby * t }
}

/** When drawing in direction start->end, find a parallel wall to the side whose
 *  endpoint lines up (along the drawing direction) within snap distance, and
 *  snap the end to that alignment. Returns the snapped point + the guide target. */
function alignmentSnap(
  start: Point,
  end: Point,
  plan: FloorPlan,
  vp: Viewport,
): { point: Point; guideTo: Point } | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const L = Math.hypot(dx, dy)
  if (L < 1) return null
  const d = { x: dx / L, y: dy / L }
  const snapW = 12 / vp.scale
  let best: { point: Point; guideTo: Point } | null = null
  let bestDelta = Infinity
  for (const w of Object.values(plan.walls)) {
    const wd = unitDir(w)
    if (Math.abs(d.x * wd.y - d.y * wd.x) >= 0.02) continue // not parallel
    for (const E of [w.a, w.b]) {
      const along = (E.x - start.x) * d.x + (E.y - start.y) * d.y
      const perp = Math.abs((E.x - start.x) * -d.y + (E.y - start.y) * d.x)
      if (perp < snapW) continue // endpoint is on the drawing line, not to a side
      if (along <= 0) continue // behind the start
      const delta = Math.abs(L - along)
      if (delta <= snapW && delta < bestDelta) {
        bestDelta = delta
        best = {
          point: { x: start.x + d.x * along, y: start.y + d.y * along },
          guideTo: { ...E },
        }
      }
    }
  }
  return best
}

type FurnEdge = 'left' | 'right' | 'top' | 'bottom'

/** Edge/endpoint resize drag — openings stretch one jamb, furniture one side. */
type SizeDrag =
  | { kind: 'opening'; id: string; side: 'low' | 'high' }
  | {
      kind: 'furniture'
      id: string
      edge: FurnEdge
      base: { center: Point; width: number; depth: number; rotation: number }
    }

/** Resize cursor matching a world-space drag direction. */
const cursorForDir = (dx: number, dy: number): string => {
  const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180
  if (ang >= 22.5 && ang < 67.5) return 'nwse-resize'
  if (ang >= 67.5 && ang < 112.5) return 'ns-resize'
  if (ang >= 112.5 && ang < 157.5) return 'nesw-resize'
  return 'ew-resize'
}

/** PowerPoint-style rotate icon: a sheet with a curved arrow over the top. */
function RotateGlyph({ dir }: { dir: 'l' | 'r' }) {
  const m = (x: number) => (dir === 'r' ? x : 16 - x) // mirror for left
  return (
    <svg width={21} height={21} viewBox="0 0 16 16" aria-hidden>
      <rect
        x={4.5}
        y={8}
        width={7}
        height={5.5}
        fill="currentColor"
        opacity={0.45}
        rx={0.5}
      />
      <path
        d={`M ${m(4)} 6 Q ${m(8)} 1.5 ${m(12)} 5.5`}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1}
        strokeLinecap="round"
      />
      <polygon
        points={`${m(12.8)},6.3 ${m(10.0)},5.7 ${m(12.2)},3.5`}
        fill="var(--accent)"
      />
    </svg>
  )
}

/** PowerPoint-style mirror icon: solid + hollow triangles over a dashed axis. */
function FlipGlyph({ axis }: { axis: 'h' | 'v' }) {
  // h = 좌우 대칭 (vertical axis), v = 상하 대칭 (horizontal axis)
  const sw = { stroke: 'currentColor', strokeWidth: 0.8, opacity: 0.45 }
  return (
    <svg width={21} height={21} viewBox="0 0 16 16" aria-hidden>
      {axis === 'h' ? (
        <>
          <line
            x1={8}
            y1={1.5}
            x2={8}
            y2={14.5}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeLinecap="round"
          />
          <polygon points="6.1,3.5 6.1,12.5 2,12.5" fill="currentColor" opacity={0.45} />
          <polygon points="9.9,3.5 9.9,12.5 14,12.5" fill="none" {...sw} />
        </>
      ) : (
        <>
          <line
            x1={1.5}
            y1={8}
            x2={14.5}
            y2={8}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeLinecap="round"
          />
          <polygon points="3.5,6.1 12.5,6.1 3.5,2" fill="currentColor" opacity={0.45} />
          <polygon points="3.5,9.9 12.5,9.9 3.5,14" fill="none" {...sw} />
        </>
      )}
    </svg>
  )
}

/** PowerPoint-style alignment icon: an anchor line + two object bars. */
function AlignGlyph({ mode }: { mode: AlignMode }) {
  const ln = {
    stroke: 'var(--accent)',
    strokeWidth: 1,
    strokeLinecap: 'round' as const,
  }
  const bar = { fill: 'currentColor', opacity: 0.45, rx: 0.5 }
  const parts: Record<AlignMode, React.ReactNode> = {
    left: (
      <>
        <line x1={3} y1={2} x2={3} y2={14} {...ln} />
        <rect x={4.5} y={3.5} width={9} height={3} {...bar} />
        <rect x={4.5} y={9.5} width={6} height={3} {...bar} />
      </>
    ),
    centerX: (
      <>
        <rect x={3.5} y={3.5} width={9} height={3} {...bar} />
        <rect x={5} y={9.5} width={6} height={3} {...bar} />
        <line x1={8} y1={2} x2={8} y2={14} {...ln} />
      </>
    ),
    right: (
      <>
        <line x1={13} y1={2} x2={13} y2={14} {...ln} />
        <rect x={2.5} y={3.5} width={9} height={3} {...bar} />
        <rect x={5.5} y={9.5} width={6} height={3} {...bar} />
      </>
    ),
    top: (
      <>
        <line x1={2} y1={3} x2={14} y2={3} {...ln} />
        <rect x={3.5} y={4.5} width={3} height={9} {...bar} />
        <rect x={9.5} y={4.5} width={3} height={6} {...bar} />
      </>
    ),
    centerY: (
      <>
        <rect x={3.5} y={3.5} width={3} height={9} {...bar} />
        <rect x={9.5} y={5} width={3} height={6} {...bar} />
        <line x1={2} y1={8} x2={14} y2={8} {...ln} />
      </>
    ),
    bottom: (
      <>
        <line x1={2} y1={13} x2={14} y2={13} {...ln} />
        <rect x={3.5} y={2.5} width={3} height={9} {...bar} />
        <rect x={9.5} y={5.5} width={3} height={6} {...bar} />
      </>
    ),
  }
  return (
    <svg width={18} height={18} viewBox="0 0 16 16" aria-hidden>
      {parts[mode]}
    </svg>
  )
}

/** Intersection of segments a-b and c-d (within both), or null. */
const segIntersect = (a: Point, b: Point, c: Point, d: Point): Point | null => {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: a.x + rx * t, y: a.y + ry * t }
}

export default function Canvas() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // restore the plan's last zoom/scroll; Canvas remounts per tab (key=id)
  const activeId = useTabsStore((s) => s.active)
  const [viewport, setViewport] = useState<Viewport>(
    () => (activeId !== 'main' && loadViewport(activeId)) || initialViewport(),
  )
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cursor, setCursor] = useState<SnapResult | null>(null)
  const [guide, setGuide] = useState<{ from: Point; to: Point } | null>(null)
  const [snapHint, setSnapHint] = useState<{
    point: Point
    kind: 'endpoint' | 'wall'
  } | null>(null)
  const [doorPreview, setDoorPreview] = useState<{
    wallId: string
    position: number
    width: number
    type: OpeningType
    flipH: boolean
    flipV: boolean
  } | null>(null)
  const [dimEdit, setDimEdit] = useState<DimEdit | null>(null)
  const [openingDimEdit, setOpeningDimEdit] = useState<{
    id: string
    side: 'low' | 'high'
    screen: Point
    value: string
    warn: string | null
  } | null>(null)
  // clearance-guide label being edited: move the furniture along n so the
  // gap becomes the entered value
  const [gapEdit, setGapEdit] = useState<{
    id: string
    n: Point // outward unit normal (world)
    dist: number // current gap (mm)
    screen: Point
    value: string
    warn: string | null
  } | null>(null)
  const [wallMenu, setWallMenu] = useState<{
    wallId: string
    point: Point
    screen: Point
  } | null>(null)
  const [doorMenu, setDoorMenu] = useState<{ id: string; screen: Point } | null>(
    null,
  )
  const [roomMenu, setRoomMenu] = useState<{
    anchor: Point // a point inside the room (world)
    polygon: Point[]
    screen: Point
  } | null>(null)
  // delete-only menu for mixed multi-selections (walls-only keeps wall menu)
  const [multiMenu, setMultiMenu] = useState<{ screen: Point } | null>(null)
  const [furnMenu, setFurnMenu] = useState<{ id: string; screen: Point } | null>(
    null,
  )
  const furnWRef = useRef<HTMLInputElement>(null)
  const furnDRef = useRef<HTMLInputElement>(null)
  // set when the right-click itself made the selection — closing that menu
  // then also deselects (a pre-existing selection stays selected)
  const menuAutoSelRef = useRef<'wall' | 'door' | 'furn' | 'room' | null>(null)
  // furniture tool: placement ghost following the cursor (wall-snapped)
  const [furnGhost, setFurnGhost] = useState<{
    center: Point
    rotation: number
  } | null>(null)
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  )
  // Space held: mouse movement pans the view (touchpads have no middle button)
  const [spacePan, setSpacePan] = useState(false)
  const spacePanLastRef = useRef<Point | null>(null)
  // middle-button pan in progress — drives the grabbing cursor
  const [wheelPan, setWheelPan] = useState(false)
  const wallDragRef = useRef<WallDrag | null>(null)
  const doorDragRef = useRef<{
    id: string
    wallId: string
    moved: boolean
    copy?: boolean // Ctrl+drag: clone on first movement, toggle-select on click
  } | null>(null)
  const furnDragRef = useRef<{
    id: string
    start: Point
    baseCenter: Point
    baseRot: number
    moved: boolean
    copy?: boolean
  } | null>(null)
  // dragging an opening jamb / furniture edge to resize
  const sizeDragRef = useRef<(SizeDrag & { moved: boolean }) | null>(null)
  const [sizeDragUi, setSizeDragUi] = useState<SizeDrag | null>(null)
  const [hoverCursor, setHoverCursor] = useState<string | null>(null)
  // dragging a multi-selection: translate selected walls and furniture, slide
  // selected openings (whose wall is not selected) along their walls
  const groupDragRef = useRef<{
    startWorld: Point
    walls: { id: string; baseA: Point; baseB: Point }[]
    openings: { id: string; wallId: string; basePos: number }[]
    furn: { id: string; baseCenter: Point }[]
    bbox: BBox | null // furniture-only drags snap by the group bbox
    moved: boolean
  } | null>(null)
  // placing a new door: hold + move to choose orientation, release to keep
  const placeRef = useRef<{ id: string; center: Point; u: Point; n: Point } | null>(
    null,
  )
  // mousedown on empty space: marquee-select on drag, pick the room on a click
  const roomPickRef = useRef<Point | null>(null)
  // left-press screen point — drags only engage after a small movement, so a
  // plain click selects without nudging/resizing the object
  const pressScreenRef = useRef<Point | null>(null)
  const [marquee, setMarquee] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // live marquee size (mm) shown at the right of the help bar
  useEffect(() => {
    usePlanStore
      .getState()
      .setMarqueeSize(
        marquee
          ? { w: marquee.w / viewport.scale, h: marquee.h / viewport.scale }
          : null,
      )
  }, [marquee, viewport.scale])
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft
  // Esc with a menu open only closes the menu (matches clicking elsewhere)
  const anyMenuOpenRef = useRef(false)
  anyMenuOpenRef.current = !!(
    wallMenu ||
    doorMenu ||
    furnMenu ||
    roomMenu ||
    multiMenu
  )

  const plan = usePlanStore((s) => s.plan)
  const tool = usePlanStore((s) => s.tool)
  const commitWall = usePlanStore((s) => s.commitWall)
  const deleteWalls = usePlanStore((s) => s.deleteWalls)
  const deleteObjects = usePlanStore((s) => s.deleteObjects)
  const splitWall = usePlanStore((s) => s.splitWall)
  const mergeWalls = usePlanStore((s) => s.mergeWalls)
  const setWallKind = usePlanStore((s) => s.setWallKind)
  const setWallTransparent = usePlanStore((s) => s.setWallTransparent)
  const duplicateObject = usePlanStore((s) => s.duplicateObject)
  const setEndpoints = usePlanStore((s) => s.setEndpoints)
  const select = usePlanStore((s) => s.select)
  const toggleSelect = usePlanStore((s) => s.toggleSelect)
  const selectOpening = usePlanStore((s) => s.selectOpening)
  const selectedOpening = usePlanStore((s) => s.selectedOpening)
  const setWallProbe = usePlanStore((s) => s.setWallProbe)
  const setRoomPick = usePlanStore((s) => s.setRoomPick)
  const doorPick = usePlanStore((s) => s.doorPick)
  const windowPick = usePlanStore((s) => s.windowPick)
  const setRoomKind = usePlanStore((s) => s.setRoomKind)
  const toggleRoomExcludeArea = usePlanStore((s) => s.toggleRoomExcludeArea)
  const addOpening = usePlanStore((s) => s.addOpening)
  const moveOpening = usePlanStore((s) => s.moveOpening)
  const removeOpening = usePlanStore((s) => s.removeOpening)
  const toggleOpeningFlip = usePlanStore((s) => s.toggleOpeningFlip)
  const setOpeningFlips = usePlanStore((s) => s.setOpeningFlips)
  const resizeOpening = usePlanStore((s) => s.resizeOpening)
  const setOpeningStyle = usePlanStore((s) => s.setOpeningStyle)
  const setTool = usePlanStore((s) => s.setTool)
  const selection = usePlanStore((s) => s.selection)
  const furniturePick = usePlanStore((s) => s.furniturePick)
  const wallPick = usePlanStore((s) => s.wallPick)
  const addFurniture = usePlanStore((s) => s.addFurniture)
  const moveFurniture = usePlanStore((s) => s.moveFurniture)
  const resizeFurniture = usePlanStore((s) => s.resizeFurniture)
  const rotateFurniture = usePlanStore((s) => s.rotateFurniture)
  const flipFurniture = usePlanStore((s) => s.flipFurniture)
  const bringFurnitureToFront = usePlanStore((s) => s.bringFurnitureToFront)
  const rotateFurnitureGroup = usePlanStore((s) => s.rotateFurnitureGroup)
  const flipFurnitureGroup = usePlanStore((s) => s.flipFurnitureGroup)
  const alignFurniture = usePlanStore((s) => s.alignFurniture)

  const isWallTool = tool === 'wall'
  const isOpeningTool = tool === 'door' || tool === 'window'

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // remember the last zoom/scroll per plan (debounced)
  useEffect(() => {
    if (activeId === 'main') return
    const t = setTimeout(() => saveViewport(activeId, viewport), 400)
    return () => clearTimeout(t)
  }, [viewport, activeId])

  useEffect(() => {
    setDraft(null)
    setGuide(null)
    setSnapHint(null)
    setDoorPreview(null)
    setFurnGhost(null)
  }, [tool])

  // Space key toggles pan-by-mouse-move (skipped while typing in an input)
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return (
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      )
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return
      e.preventDefault() // no page scroll / focused-button click
      spacePanLastRef.current = null
      setSpacePan(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePan(false)
    }
    const cancel = () => setSpacePan(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      ) {
        return
      }
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        const temporal = usePlanStore.temporal.getState()
        if (e.shiftKey) temporal.redo()
        else temporal.undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        usePlanStore.temporal.getState().redo()
        return
      }
      if (e.key === 'Escape') {
        if (anyMenuOpenRef.current) {
          closeCtxMenus() // only close the menu; keep what's selected
          return
        }
        if (tool !== 'select') {
          if (draftRef.current) {
            setDraft(null) // first Esc: end the current chain, stay in draw mode
            setGuide(null)
          } else {
            setTool('select') // second Esc: leave drawing
          }
        } else {
          select([])
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.length) deleteObjects(selection)
        else if (selectedOpening) removeOpening(selectedOpening)
      }
      const arrowDir = ARROW_DIRS[e.key]
      if (arrowDir && tool === 'select') {
        const st = usePlanStore.getState()
        const sel = st.selection
        if (!sel.length) return
        e.preventDefault()
        // Ctrl makes a 100mm step instead of 10mm
        const step = mod ? 10 : 1
        const arrow = { x: arrowDir.x * step, y: arrowDir.y * step }
        const p = st.plan
        const wallIds = sel.filter((id) => p.walls[id])
        const opIds = sel.filter((id) => p.openings[id])
        const fnIds = sel.filter((id) => p.furniture?.[id])
        const wallSet = new Set(wallIds)

        // openings not riding a selected wall slide along their own wall
        const opMoves: { id: string; pos: number }[] = []
        for (const opId of opIds) {
          const op = p.openings[opId]
          const w = p.walls[op.wallId]
          if (!w || wallSet.has(op.wallId)) continue
          const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
          const proj =
            (arrow.x * (w.b.x - w.a.x) + arrow.y * (w.b.y - w.a.y)) / len
          if (Math.abs(proj) < 1e-9) continue
          const hw = op.width / 2
          const exLo = op.style === 'pocket' && !op.flipH ? op.width : 0
          const exHi = op.style === 'pocket' && op.flipH ? op.width : 0
          opMoves.push({
            id: opId,
            pos: Math.max(
              hw + exLo,
              Math.min(
                len - hw - exHi,
                snap10(op.position + Math.sign(proj) * 10 * step),
              ),
            ),
          })
        }

        if (sel.length === 1 && wallIds.length === 1) {
          // single wall: perpendicular-axis lock (Shift frees it), joints follow
          const w = p.walls[wallIds[0]]
          let mx = arrow.x
          let my = arrow.y
          if (!e.shiftKey) {
            if (Math.abs(w.b.x - w.a.x) >= Math.abs(w.b.y - w.a.y)) mx = 0
            else my = 0
          }
          if (!mx && !my) return
          const splits = splitJointEnds(p, w)
          const attached = furnitureOnWall(p, w)
          beginDrag()
          st.setEndpoints(
            collectMovers(p, w).map((m) => ({
              wallId: m.wallId,
              end: m.end,
              point: { x: m.base.x + mx, y: m.base.y + my },
            })),
          )
          for (const f of attached) {
            st.moveFurniture(f.id, { x: f.center.x + mx, y: f.center.y + my })
          }
          bridgeSplitJoints(w.id, splits)
          endDrag()
          return
        }

        if (!wallIds.length && !opMoves.length && !fnIds.length) return
        beginDrag()
        if (wallIds.length) {
          st.setEndpoints(
            wallIds.flatMap((id) => {
              const w = p.walls[id]
              return [
                {
                  wallId: id,
                  end: 'a' as WallEnd,
                  point: { x: w.a.x + arrow.x, y: w.a.y + arrow.y },
                },
                {
                  wallId: id,
                  end: 'b' as WallEnd,
                  point: { x: w.b.x + arrow.x, y: w.b.y + arrow.y },
                },
              ]
            }),
          )
        }
        for (const m of opMoves) st.moveOpening(m.id, m.pos)
        for (const id of fnIds) {
          const f = p.furniture[id]
          st.moveFurniture(id, {
            x: f.center.x + arrow.x,
            y: f.center.y + arrow.y,
          })
        }
        endDrag()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, selectedOpening, deleteObjects, removeOpening, tool, setTool, select])

  const pointer = (
    stage: ReturnType<KonvaEventObject<MouseEvent>['target']['getStage']>,
  ) => stage?.getPointerPosition() ?? null

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const ptr = pointer(e.target.getStage())
    if (!ptr) return
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1
    setViewport((vp) => zoomAt(vp, ptr, factor))
  }

  const startGroupDrag = (world: Point) => {
    const walls = selection
      .map((id) => plan.walls[id])
      .filter(Boolean)
      .map((w) => ({ id: w.id, baseA: { ...w.a }, baseB: { ...w.b } }))
    const wallSet = new Set(walls.map((w) => w.id))
    const openings = selection
      .map((id) => plan.openings[id])
      .filter((o) => o && !wallSet.has(o.wallId)) // wall-bound ones follow their wall
      .map((o) => ({ id: o.id, wallId: o.wallId, basePos: o.position }))
    const furnPieces = selection.map((id) => plan.furniture?.[id]).filter(Boolean)
    const furn = furnPieces.map((f) => ({ id: f.id, baseCenter: { ...f.center } }))
    if (!walls.length && !openings.length && !furn.length) return
    const bbox =
      !walls.length && !openings.length ? furnitureBBox(furnPieces) : null
    beginDrag()
    groupDragRef.current = {
      startWorld: world,
      walls,
      openings,
      furn,
      bbox,
      moved: false,
    }
  }

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    const ptr = pointer(e.target.getStage())
    if (!ptr) return
    setWallMenu(null)
    setDoorMenu(null)
    if (spacePan) return // panning: clicks must not select/draw

    if (e.evt.button === 1) {
      e.evt.preventDefault()
      panRef.current = {
        sx: ptr.x,
        sy: ptr.y,
        ox: viewport.offsetX,
        oy: viewport.offsetY,
      }
      setWheelPan(true)
      return
    }
    if (e.evt.button !== 0) return
    pressScreenRef.current = { x: ptr.x, y: ptr.y }

    if (tool === 'select') {
      // a door takes priority over the wall it sits on
      const world0 = screenToWorld(ptr, viewport)
      // edge/jamb resize zones take priority over body drags
      if (!(e.evt.ctrlKey || e.evt.metaKey)) {
        const oe = openingEndAt(world0)
        if (oe) {
          selectOpening(oe.id)
          beginDrag()
          sizeDragRef.current = { kind: 'opening', id: oe.id, side: oe.side, moved: false }
          setSizeDragUi({ kind: 'opening', id: oe.id, side: oe.side })
          return
        }
        const fe = furnitureEdgeAt(world0)
        if (fe) {
          const f = plan.furniture[fe.id]
          select([fe.id])
          beginDrag()
          const sd: SizeDrag = {
            kind: 'furniture',
            id: fe.id,
            edge: fe.edge,
            base: {
              center: { ...f.center },
              width: f.width,
              depth: f.depth,
              rotation: f.rotation,
            },
          }
          sizeDragRef.current = { ...sd, moved: false }
          setSizeDragUi(sd)
          return
        }
      }
      const ctrl = e.evt.ctrlKey || e.evt.metaKey
      const opId = openingAt(world0)
      if (opId) {
        if (!ctrl && selection.length > 1 && selection.includes(opId)) {
          startGroupDrag(world0) // move the whole multi-selection
          return
        }
        // Ctrl: drag copies the object; a plain click still toggle-selects
        if (!ctrl) selectOpening(opId)
        beginDrag()
        doorDragRef.current = {
          id: opId,
          wallId: plan.openings[opId].wallId,
          moved: false,
          copy: ctrl,
        }
        return
      }
      const fnId = furnitureAt(world0)
      if (fnId) {
        if (!ctrl && selection.length > 1 && selection.includes(fnId)) {
          startGroupDrag(world0) // move the whole multi-selection
          return
        }
        const f = plan.furniture[fnId]
        if (!ctrl) select([fnId])
        beginDrag()
        furnDragRef.current = {
          id: fnId,
          start: world0,
          baseCenter: { ...f.center },
          baseRot: f.rotation,
          moved: false,
          copy: ctrl,
        }
        return
      }
      const name = typeof e.target.name === 'function' ? e.target.name() : ''
      if (name.startsWith(WALL_NAME_PREFIX)) {
        const wallId = name.slice(WALL_NAME_PREFIX.length)
        const w = plan.walls[wallId]
        if (w) {
          if (!ctrl && selection.length > 1 && selection.includes(wallId)) {
            startGroupDrag(world0) // move the whole multi-selection
            return
          }
          const world = screenToWorld(ptr, viewport)
          if (ctrl) {
            // Ctrl+drag copies the wall alone (neighbours stay); a plain
            // Ctrl+click still toggle-selects on mouse-up
            beginDrag()
            wallDragRef.current = {
              wallId,
              baseA: { ...w.a },
              horizontalWall:
                Math.abs(w.b.x - w.a.x) >= Math.abs(w.b.y - w.a.y),
              startWorld: world,
              moved: false,
              movers: [
                { wallId, end: 'a', base: { ...w.a } },
                { wallId, end: 'b', base: { ...w.b } },
              ],
              splits: [],
              furn: [],
              copy: true,
            }
            return
          }
          select([wallId])
          const abx = w.b.x - w.a.x
          const aby = w.b.y - w.a.y
          const len2 = abx * abx + aby * aby
          const t =
            len2 === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    ((world.x - w.a.x) * abx + (world.y - w.a.y) * aby) / len2,
                  ),
                )
          setWallProbe({ wallId, t })
          beginDrag()
          wallDragRef.current = {
            wallId,
            baseA: { ...w.a },
            horizontalWall:
              Math.abs(w.b.x - w.a.x) >= Math.abs(w.b.y - w.a.y),
            startWorld: world,
            moved: false,
            // corners + T-joints follow; collinear continuations (splits) don't
            movers: collectMovers(plan, w),
            splits: splitJointEnds(plan, w),
            furn: furnitureOnWall(plan, w).map((f) => ({
              id: f.id,
              base: { ...f.center },
            })),
          }
        }
        return
      }
      if (e.target === e.target.getStage()) {
        // room picking happens on mouse UP (and only if the mouse didn't move)
        roomPickRef.current = { x: ptr.x, y: ptr.y }
      }
      return
    }

    if (tool === 'furniture') {
      // click places the ghost; stay in the tool to place more
      if (furniturePick && furnGhost) {
        addFurniture(
          furniturePick.kind,
          furnGhost.center,
          furniturePick.width,
          furniturePick.depth,
          furnGhost.rotation,
        )
      }
      return
    }

    if (isOpeningTool) {
      onOpeningMouseDown(screenToWorld(ptr, viewport), tool as OpeningType)
      return
    }

    // drawing mode (wall tool — kind/transparency from the toolbar pick)
    const { s } = drawPoint(screenToWorld(ptr, viewport), e.evt.shiftKey)
    setSnapHint(hintFrom(s))
    if (!draft) {
      setDraft({ start: s, end: s })
    } else {
      commitWall(draft.start.point, s.point, wallPick.kind, wallPick.transparent)
      setDraft({ start: s, end: s }) // chain into a polyline
    }
  }

  const wallPosOf = (point: Point, w: Wall) => {
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
    return (
      ((point.x - w.a.x) * (w.b.x - w.a.x) +
        (point.y - w.a.y) * (w.b.y - w.a.y)) /
      len
    )
  }

  // span an opening occupies on its wall — a pocket door (미닫이) also claims
  // the wall it slides into, one extra width past the jamb
  const occupiedSpan = (o: {
    position: number
    width: number
    flipH?: boolean
    style?: string
  }): [number, number] => {
    let lo = o.position - o.width / 2
    let hi = o.position + o.width / 2
    if (o.style === 'pocket') {
      if (o.flipH) hi += o.width
      else lo -= o.width
    }
    return [lo, hi]
  }

  // does a door span [pos±width/2] overlap an existing opening on the wall?
  const spanOverlapsOpening = (wallId: string, pos: number, width: number) => {
    const lo = pos - width / 2
    const hi = pos + width / 2
    return Object.values(plan.openings).some((o) => {
      if (o.wallId !== wallId) return false
      const [olo, ohi] = occupiedSpan(o)
      return !(hi <= olo || lo >= ohi)
    })
  }

  // walls that can't carry openings (virtual walls)
  const transparentWallIds = () =>
    Object.values(plan.walls)
      .filter((w) => w.transparent)
      .map((w) => w.id)

  // opening tool mousedown: drag an existing one, or place a new door/window
  const onOpeningMouseDown = (world: Point, type: OpeningType) => {
    const hit = nearestWall(world, plan, viewport, transparentWallIds(), 16)
    if (!hit) {
      selectOpening(null)
      return
    }
    const w = plan.walls[hit.wallId]
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (len < 1) return
    const pos = wallPosOf(hit.point, w)
    const existing = Object.values(plan.openings).find(
      (o) => o.wallId === hit.wallId && Math.abs(o.position - pos) <= o.width / 2,
    )
    if (existing) {
      selectOpening(existing.id) // select; stays selected through the drag
      beginDrag() // start moving it
      doorDragRef.current = { id: existing.id, wallId: hit.wallId, moved: false }
      return
    }
    // create a new opening; hold + move to set its orientation
    const pick = type === 'door' ? doorPick : windowPick
    const width = Math.min(pick.width, len * 0.8)
    const cpos = Math.max(width / 2, Math.min(len - width / 2, snap10(pos)))
    if (spanOverlapsOpening(hit.wallId, cpos, width)) return // would overlap
    const ux = (w.b.x - w.a.x) / len
    const uy = (w.b.y - w.a.y) / len
    beginDrag()
    const id = addOpening(hit.wallId, cpos, width, type, pick.style)
    const f = flipsFor(world, w, cpos)
    setOpeningFlips(id, f.flipH, f.flipV)
    selectOpening(id)
    placeRef.current = {
      id,
      center: { x: w.a.x + ux * cpos, y: w.a.y + uy * cpos },
      u: { x: ux, y: uy },
      n: { x: -uy, y: ux },
    }
    setDoorPreview(null)
  }

  // resolve the draw point: snap, then (when drawing) align to a side wall's
  // endpoint along the drawing direction, exposing a guide line
  const drawPoint = (
    world: Point,
    shift: boolean,
  ): { s: SnapResult; guide: { from: Point; to: Point } | null } => {
    const base = snap(world, plan, viewport, {
      from: draft?.start.point,
      ortho: !shift,
      snapEndpoints: true,
      snapWalls: true,
    })
    if (!draft || base.atEndpoint || base.onWall) return { s: base, guide: null }
    const al = alignmentSnap(draft.start.point, base.point, plan, viewport)
    if (al) return { s: { point: al.point }, guide: { from: al.point, to: al.guideTo } }
    return { s: base, guide: null }
  }

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const ptr = pointer(e.target.getStage())
    if (!ptr) return

    if (spacePan) {
      const last = spacePanLastRef.current
      spacePanLastRef.current = ptr
      if (last) {
        setViewport((vp) => ({
          ...vp,
          offsetX: vp.offsetX + (ptr.x - last.x),
          offsetY: vp.offsetY + (ptr.y - last.y),
        }))
      }
      return
    }

    if (panRef.current) {
      const p = panRef.current
      setViewport((vp) => ({
        ...vp,
        offsetX: p.ox + (ptr.x - p.sx),
        offsetY: p.oy + (ptr.y - p.sy),
      }))
      return
    }

    // drag from empty space: rubber-band selection rectangle
    if (roomPickRef.current && e.evt.buttons & 1) {
      const d = roomPickRef.current
      if (marquee || Math.hypot(ptr.x - d.x, ptr.y - d.y) > 4) {
        setMarquee({
          x: Math.min(d.x, ptr.x),
          y: Math.min(d.y, ptr.y),
          w: Math.abs(ptr.x - d.x),
          h: Math.abs(ptr.y - d.y),
        })
      }
      return
    }

    // drags engage only after the pointer leaves a small dead zone, so a
    // click with a tiny wobble still counts as plain selection
    const press = pressScreenRef.current
    const inDeadZone = (moved: boolean) =>
      !moved && !!press && Math.hypot(ptr.x - press.x, ptr.y - press.y) < 4

    const pr = placeRef.current
    if (pr) {
      const world = screenToWorld(ptr, viewport)
      const dx = world.x - pr.center.x
      const dy = world.y - pr.center.y
      const along = dx * pr.u.x + dy * pr.u.y
      const across = dx * pr.n.x + dy * pr.n.y
      setOpeningFlips(pr.id, along > 0, across < 0)
      return
    }

    const sd = sizeDragRef.current
    if (sd) {
      if (inDeadZone(sd.moved)) return
      const world = screenToWorld(ptr, viewport)
      if (sd.kind === 'opening') {
        const op = plan.openings[sd.id]
        const w = op ? plan.walls[op.wallId] : null
        if (op && w) {
          // drag one jamb; the other stays put — same limits as the size menu
          const pos = wallPosOf(world, w)
          const [lo, hi] = wallSegmentAt(plan, op.wallId, op.position)
          const maxW = Math.max(300, hi - lo - 100)
          if (sd.side === 'high') {
            const fix = op.position - op.width / 2
            const m = Math.max(
              fix + 300,
              Math.min(Math.min(hi, fix + maxW), snap10(pos)),
            )
            resizeOpening(sd.id, m - fix, (fix + m) / 2)
          } else {
            const fix = op.position + op.width / 2
            const m = Math.min(
              fix - 300,
              Math.max(Math.max(lo, fix - maxW), snap10(pos)),
            )
            resizeOpening(sd.id, fix - m, (fix + m) / 2)
          }
          sd.moved = true
        }
        return
      }
      const f = plan.furniture?.[sd.id]
      if (f) {
        // drag one edge; the opposite edge stays put, growth stops at the
        // first wall face in the way
        const b = sd.base
        const r = (b.rotation * Math.PI) / 180
        const ax = { x: Math.cos(r), y: Math.sin(r) }
        const ay = { x: -Math.sin(r), y: Math.cos(r) }
        const horizontal = sd.edge === 'left' || sd.edge === 'right'
        const sgn = sd.edge === 'right' || sd.edge === 'bottom' ? 1 : -1
        const axis = horizontal ? ax : ay // local axis being resized
        const span = horizontal ? b.width : b.depth
        const cross = horizontal ? b.depth : b.width
        const dir = { x: axis.x * sgn, y: axis.y * sgn } // moving-edge direction
        // cursor distance from the fixed edge
        const raw =
          ((world.x - b.center.x) * axis.x + (world.y - b.center.y) * axis.y) *
            sgn +
          span / 2
        // fixed edge center (the anchor) and the moving edge at drag start;
        // the limit is current size + room ahead of the MOVING edge, so a
        // piece already overlapping a wall never snaps down suddenly
        const fc = {
          x: b.center.x - dir.x * (span / 2),
          y: b.center.y - dir.y * (span / 2),
        }
        const mc = {
          x: b.center.x + dir.x * (span / 2),
          y: b.center.y + dir.y * (span / 2),
        }
        const edgeAxis = horizontal ? ay : ax
        const origins = [-1, 0, 1].map((k) => ({
          x: mc.x + edgeAxis.x * k * (cross / 2),
          y: mc.y + edgeAxis.y * k * (cross / 2),
        }))
        const ext = extentToWall(plan, origins, dir)
        const limit = Math.min(10000, Math.floor((span + ext) / 10) * 10)
        const size = Math.max(100, Math.min(limit, snap10(raw)))
        resizeFurniture(
          sd.id,
          horizontal ? size : b.width,
          horizontal ? b.depth : size,
        )
        moveFurniture(sd.id, {
          x: fc.x + dir.x * (size / 2),
          y: fc.y + dir.y * (size / 2),
        })
        sd.moved = true
      }
      return
    }

    const dd = doorDragRef.current
    if (dd) {
      if (inDeadZone(dd.moved)) return
      if (dd.copy && !dd.moved) {
        const nid = duplicateObject(dd.id) // Ctrl+drag: move a fresh copy
        if (nid) {
          dd.id = nid
          selectOpening(nid)
        }
      }
      const w = plan.walls[dd.wallId]
      const op = usePlanStore.getState().plan.openings[dd.id]
      if (w && op) {
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
        const pos = wallPosOf(screenToWorld(ptr, viewport), w)
        const hw = op.width / 2
        // a pocket door needs room on its slide-in side as well
        const exLo = op.style === 'pocket' && !op.flipH ? op.width : 0
        const exHi = op.style === 'pocket' && op.flipH ? op.width : 0
        moveOpening(
          dd.id,
          Math.max(hw + exLo, Math.min(len - hw - exHi, snap10(pos))),
        )
        dd.moved = true
      }
      return
    }

    const fd = furnDragRef.current
    if (fd) {
      if (inDeadZone(fd.moved)) return
      if (fd.copy && !fd.moved) {
        const nid = duplicateObject(fd.id) // Ctrl+drag: move a fresh copy
        if (nid) {
          fd.id = nid
          select([nid])
        }
      }
      const f = usePlanStore.getState().plan.furniture?.[fd.id]
      if (f) {
        const world = screenToWorld(ptr, viewport)
        const raw = {
          x: fd.baseCenter.x + world.x - fd.start.x,
          y: fd.baseCenter.y + world.y - fd.start.y,
        }
        const s = snapFurniture(plan, raw, f.width, f.depth, fd.baseRot)
        moveFurniture(fd.id, s.center, s.rotation)
        fd.moved = true
      }
      return
    }

    const gd = groupDragRef.current
    if (gd) {
      if (inDeadZone(gd.moved)) return
      const world = screenToWorld(ptr, viewport)
      let dx = world.x - gd.startWorld.x
      let dy = world.y - gd.startWorld.y
      // furniture-only drag: snap the group as one unit by its bounding box
      if (gd.bbox) {
        const corr = snapBBox(plan, {
          minX: gd.bbox.minX + dx,
          minY: gd.bbox.minY + dy,
          maxX: gd.bbox.maxX + dx,
          maxY: gd.bbox.maxY + dy,
        })
        dx += corr.x
        dy += corr.y
      }
      if (gd.walls.length) {
        setEndpoints(
          gd.walls.flatMap((gw) => [
            {
              wallId: gw.id,
              end: 'a' as WallEnd,
              point: { x: gw.baseA.x + dx, y: gw.baseA.y + dy },
            },
            {
              wallId: gw.id,
              end: 'b' as WallEnd,
              point: { x: gw.baseB.x + dx, y: gw.baseB.y + dy },
            },
          ]),
        )
      }
      // openings not riding a selected wall slide along their own wall
      for (const go of gd.openings) {
        const w = plan.walls[go.wallId]
        const op = plan.openings[go.id]
        if (!w || !op) continue
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
        const along =
          (dx * (w.b.x - w.a.x)) / len + (dy * (w.b.y - w.a.y)) / len
        const hw = op.width / 2
        const exLo = op.style === 'pocket' && !op.flipH ? op.width : 0
        const exHi = op.style === 'pocket' && op.flipH ? op.width : 0
        moveOpening(
          go.id,
          Math.max(
            hw + exLo,
            Math.min(len - hw - exHi, snap10(go.basePos + along)),
          ),
        )
      }
      for (const gf of gd.furn) {
        moveFurniture(gf.id, {
          x: gf.baseCenter.x + dx,
          y: gf.baseCenter.y + dy,
        })
      }
      gd.moved = true
      return
    }

    const wd = wallDragRef.current
    if (wd) {
      if (inDeadZone(wd.moved)) return
      if (wd.copy && !wd.moved) {
        // Ctrl+drag: from here on we move a fresh copy of the wall
        const nid = duplicateObject(wd.wallId)
        if (nid) {
          wd.wallId = nid
          wd.movers = wd.movers.map((m) => ({ ...m, wallId: nid }))
          select([nid])
        }
      }
      const world = screenToWorld(ptr, viewport)
      let mvx = world.x - wd.startWorld.x
      let mvy = world.y - wd.startWorld.y
      if (!e.evt.shiftKey) {
        if (wd.horizontalWall) mvx = 0
        else mvy = 0
      }
      const s = snap({ x: wd.baseA.x + mvx, y: wd.baseA.y + mvy }, plan, viewport, {
        snapEndpoints: false,
      })
      let dx = s.point.x - wd.baseA.x
      let dy = s.point.y - wd.baseA.y
      if (!e.evt.shiftKey) {
        if (wd.horizontalWall) dx = 0
        else dy = 0
      }
      setEndpoints(
        wd.movers.map((m) => ({
          wallId: m.wallId,
          end: m.end,
          point: { x: m.base.x + dx, y: m.base.y + dy },
        })),
      )
      for (const ff of wd.furn) {
        moveFurniture(ff.id, { x: ff.base.x + dx, y: ff.base.y + dy })
      }
      wd.moved = true
      return
    }

    if (isWallTool) {
      const { s, guide: g } = drawPoint(screenToWorld(ptr, viewport), e.evt.shiftKey)
      setCursor(s)
      setGuide(g)
      setSnapHint(hintFrom(s))
      if (draft) setDraft((d) => (d ? { start: d.start, end: s } : d))
    }

    if (isOpeningTool) {
      const world = screenToWorld(ptr, viewport)
      const hit = nearestWall(world, plan, viewport, transparentWallIds(), 16)
      if (hit) {
        const w = plan.walls[hit.wallId]
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
        const width = Math.min(900, len * 0.8)
        const pos = wallPosOf(hit.point, w)
        const cpos = Math.max(width / 2, Math.min(len - width / 2, snap10(pos)))
        // hide the preview where it would overlap an existing opening
        setDoorPreview(
          spanOverlapsOpening(hit.wallId, cpos, width)
            ? null
            : {
                wallId: hit.wallId,
                position: cpos,
                width,
                type: tool as OpeningType,
                ...flipsFor(world, w, cpos),
              },
        )
      } else {
        setDoorPreview(null)
      }
    }

    if (tool === 'furniture' && furniturePick) {
      const world = screenToWorld(ptr, viewport)
      const s = snapFurniture(
        plan,
        world,
        furniturePick.width,
        furniturePick.depth,
        furnGhost?.rotation ?? 0,
      )
      setFurnGhost({ center: s.center, rotation: s.rotation })
    }

    // selected objects: resize cursor near jambs/edges, move cursor on body
    if (tool === 'select') {
      const world = screenToWorld(ptr, viewport)
      let cur: string | null = null
      const oe = openingEndAt(world)
      const fe = oe ? null : furnitureEdgeAt(world)
      if (oe) cur = cursorForDir(oe.u.x, oe.u.y)
      else if (fe) cur = cursorForDir(fe.dir.x, fe.dir.y)
      else {
        const opId = openingAt(world)
        const fnId = opId ? null : furnitureAt(world)
        const name = typeof e.target.name === 'function' ? e.target.name() : ''
        const wallId = name.startsWith(WALL_NAME_PREFIX)
          ? name.slice(WALL_NAME_PREFIX.length)
          : null
        if (
          (opId && selection.includes(opId)) ||
          (fnId && selection.includes(fnId)) ||
          (wallId && selection.includes(wallId))
        ) {
          cur = 'move'
        }
      }
      setHoverCursor(cur)
    }
  }

  const onMouseUp = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button === 1) {
      panRef.current = null
      setWheelPan(false)
    }
    pressScreenRef.current = null
    if (roomPickRef.current) {
      const down = roomPickRef.current
      roomPickRef.current = null
      const ptr = pointer(e.target.getStage())
      if (marquee) {
        // marquee: select walls/openings touching the rectangle
        const a = screenToWorld({ x: marquee.x, y: marquee.y }, viewport)
        const b = screenToWorld(
          { x: marquee.x + marquee.w, y: marquee.y + marquee.h },
          viewport,
        )
        const x1 = Math.min(a.x, b.x)
        const x2 = Math.max(a.x, b.x)
        const y1 = Math.min(a.y, b.y)
        const y2 = Math.max(a.y, b.y)
        // segment vs axis-aligned rect (Liang-Barsky clipping)
        const segHitsRect = (p: Point, q: Point) => {
          let t0 = 0
          let t1 = 1
          for (const [d, lo, hi, s] of [
            [q.x - p.x, x1, x2, p.x],
            [q.y - p.y, y1, y2, p.y],
          ]) {
            if (d === 0) {
              if (s < lo || s > hi) return false
            } else {
              const ta = (lo - s) / d
              const tb = (hi - s) / d
              t0 = Math.max(t0, Math.min(ta, tb))
              t1 = Math.min(t1, Math.max(ta, tb))
              if (t0 > t1) return false
            }
          }
          return true
        }
        const ids: string[] = []
        for (const w of Object.values(plan.walls)) {
          if (segHitsRect(w.a, w.b)) ids.push(w.id)
        }
        for (const o of Object.values(plan.openings)) {
          const w = plan.walls[o.wallId]
          if (!w) continue
          const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
          const ux = (w.b.x - w.a.x) / len
          const uy = (w.b.y - w.a.y) / len
          const pLo = {
            x: w.a.x + ux * (o.position - o.width / 2),
            y: w.a.y + uy * (o.position - o.width / 2),
          }
          const pHi = {
            x: w.a.x + ux * (o.position + o.width / 2),
            y: w.a.y + uy * (o.position + o.width / 2),
          }
          if (segHitsRect(pLo, pHi)) ids.push(o.id)
        }
        for (const f of Object.values(plan.furniture ?? {})) {
          const cs = furnitureCorners(f)
          if (
            cs.some((p, i) => segHitsRect(p, cs[(i + 1) % 4])) ||
            furnitureHit({ x: x1, y: y1 }, f) // marquee fully inside the rect
          ) {
            ids.push(f.id)
          }
        }
        // Ctrl+marquee adds to the existing selection instead of replacing it
        const prev =
          e.evt.ctrlKey || e.evt.metaKey
            ? usePlanStore.getState().selection
            : []
        select([...prev, ...ids.filter((id) => !prev.includes(id))])
        setMarquee(null)
      } else if (ptr && Math.hypot(ptr.x - down.x, ptr.y - down.y) < 5) {
        select([]) // clears roomPick too
        setRoomPick(screenToWorld(ptr, viewport)) // show area of room here, if any
      }
    }
    if (groupDragRef.current) {
      if (groupDragRef.current.moved) endDrag()
      else cancelDrag()
      groupDragRef.current = null
    }
    if (wallDragRef.current) {
      if (wallDragRef.current.moved) {
        // moving away from a split joint: bridge old joint → new end (new T)
        bridgeSplitJoints(wallDragRef.current.wallId, wallDragRef.current.splits)
        endDrag()
      } else {
        cancelDrag()
        // Ctrl+click without movement keeps the multi-select behaviour
        if (wallDragRef.current.copy) toggleSelect(wallDragRef.current.wallId)
      }
      wallDragRef.current = null
    }
    if (doorDragRef.current) {
      if (doorDragRef.current.moved) endDrag()
      else {
        cancelDrag() // clicked a door without dragging — no change recorded
        if (doorDragRef.current.copy) toggleSelect(doorDragRef.current.id)
      }
      doorDragRef.current = null
    }
    if (furnDragRef.current) {
      if (furnDragRef.current.moved) endDrag()
      else {
        cancelDrag()
        if (furnDragRef.current.copy) toggleSelect(furnDragRef.current.id)
      }
      furnDragRef.current = null
    }
    if (sizeDragRef.current) {
      if (sizeDragRef.current.moved) endDrag()
      else cancelDrag()
      sizeDragRef.current = null
      setSizeDragUi(null)
    }
    if (placeRef.current) {
      endDrag() // the new door + chosen orientation is one undo step
      placeRef.current = null
    }
  }

  // opening end (jamb) near the world point — for edge resizing
  const openingEndAt = (
    world: Point,
  ): { id: string; side: 'low' | 'high'; u: Point } | null => {
    const tol = 5 / viewport.scale
    for (const o of Object.values(plan.openings)) {
      if (!selection.includes(o.id)) continue // resize only when selected
      const w = plan.walls[o.wallId]
      if (!w) continue
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
      const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
      for (const side of ['low', 'high'] as const) {
        const pos = o.position + (side === 'low' ? -1 : 1) * (o.width / 2)
        const p = { x: w.a.x + u.x * pos, y: w.a.y + u.y * pos }
        if (Math.hypot(world.x - p.x, world.y - p.y) <= tol) {
          return { id: o.id, side, u }
        }
      }
    }
    return null
  }

  // furniture edge near the world point — for edge resizing
  const furnitureEdgeAt = (
    world: Point,
  ): { id: string; edge: FurnEdge; dir: Point } | null => {
    const tol = 5 / viewport.scale
    const all = Object.values(plan.furniture ?? {})
    for (let i = all.length - 1; i >= 0; i--) {
      const f = all[i]
      if (!selection.includes(f.id)) continue // resize only when selected
      const r = (f.rotation * Math.PI) / 180
      const ax = { x: Math.cos(r), y: Math.sin(r) } // local +x in world
      const ay = { x: -Math.sin(r), y: Math.cos(r) } // local +y in world
      const dx = world.x - f.center.x
      const dy = world.y - f.center.y
      const lx = dx * ax.x + dy * ax.y
      const ly = dx * ay.x + dy * ay.y
      const hw = f.width / 2
      const hd = f.depth / 2
      const distX = Math.abs(Math.abs(lx) - hw) // to the nearer x edge
      const distY = Math.abs(Math.abs(ly) - hd)
      const nearX = distX <= tol && Math.abs(ly) <= hd + tol
      const nearY = distY <= tol && Math.abs(lx) <= hw + tol
      if (!nearX && !nearY) continue
      if (nearX && (!nearY || distX <= distY)) {
        return lx > 0
          ? { id: f.id, edge: 'right', dir: ax }
          : { id: f.id, edge: 'left', dir: ax }
      }
      return ly > 0
        ? { id: f.id, edge: 'bottom', dir: ay }
        : { id: f.id, edge: 'top', dir: ay }
    }
    return null
  }

  // furniture under the world point, or null — topmost (last-stacked) first
  const furnitureAt = (world: Point): string | null => {
    const all = Object.values(plan.furniture ?? {})
    for (let i = all.length - 1; i >= 0; i--) {
      if (furnitureHit(world, all[i])) return all[i].id
    }
    return null
  }

  // opening whose body is under the world point, or null
  const openingAt = (world: Point): string | null => {
    for (const o of Object.values(plan.openings)) {
      const w = plan.walls[o.wallId]
      if (!w) continue
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
      const ux = (w.b.x - w.a.x) / len
      const uy = (w.b.y - w.a.y) / len
      const along = (world.x - w.a.x) * ux + (world.y - w.a.y) * uy
      const perp = Math.abs((world.x - w.a.x) * -uy + (world.y - w.a.y) * ux)
      const margin = Math.max(w.thickness / 2, 10 / viewport.scale)
      if (Math.abs(along - o.position) <= o.width / 2 && perp <= margin) return o.id
    }
    return null
  }

  /** Close every context menu; if the menu's selection came from the
   *  right-click itself, drop that selection too. */
  const closeCtxMenus = () => {
    const auto = menuAutoSelRef.current
    menuAutoSelRef.current = null
    if (auto === 'door') selectOpening(null)
    else if (auto === 'wall' || auto === 'furn') select([])
    else if (auto === 'room') select([]) // clears roomPick too
    setWallMenu(null)
    setDoorMenu(null)
    setFurnMenu(null)
    setRoomMenu(null)
    setMultiMenu(null)
  }

  const onContextMenu = (e: KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault()
    const ptr0 = pointer(e.target.getStage())
    // a mixed multi-selection only supports deletion: show the delete-only
    // menu (wall-only selections keep the multi wall menu, e.g. for merging)
    if (
      tool === 'select' &&
      selection.length > 1 &&
      !selection.every((id) => plan.walls[id]) &&
      ptr0
    ) {
      menuAutoSelRef.current = null // selection pre-existed by definition
      setMultiMenu({ screen: ptr0 })
      setWallMenu(null)
      setDoorMenu(null)
      setFurnMenu(null)
      return
    }
    if (ptr0) {
      const opId = openingAt(screenToWorld(ptr0, viewport))
      if (opId) {
        menuAutoSelRef.current = selectedOpening === opId ? null : 'door'
        selectOpening(opId) // select the door first
        setDoorMenu({ id: opId, screen: ptr0 })
        setWallMenu(null)
        setFurnMenu(null)
        return
      }
      if (tool === 'select') {
        const fnId = furnitureAt(screenToWorld(ptr0, viewport))
        if (fnId) {
          menuAutoSelRef.current = selection.includes(fnId) ? null : 'furn'
          select([fnId])
          setFurnMenu({ id: fnId, screen: ptr0 })
          setWallMenu(null)
          setDoorMenu(null)
          return
        }
      }
    }
    if (tool !== 'select') {
      setDraft(null) // end the current chain
      setGuide(null)
      return
    }
    // select mode: right-clicking a wall selects it and opens its menu
    const name = typeof e.target.name === 'function' ? e.target.name() : ''
    const ptr = pointer(e.target.getStage())
    if (!name.startsWith(WALL_NAME_PREFIX) || !ptr) {
      setWallMenu(null)
      // right-click inside a room picks it (like a left click) and opens
      // its menu right away — same as walls and furniture
      if (ptr) {
        const world = screenToWorld(ptr, viewport)
        const room = detectRooms(plan).find((r) =>
          pointInPolygon(world, r.polygon),
        )
        if (room) {
          // already-picked room stays picked after the menu closes
          const prevPick = usePlanStore.getState().roomPick
          menuAutoSelRef.current =
            prevPick && pointInPolygon(prevPick, room.polygon) ? null : 'room'
          select([]) // clears any object selection (and roomPick)
          setRoomPick(world)
          setRoomMenu({ anchor: world, polygon: room.polygon, screen: ptr })
          setDoorMenu(null)
        }
      }
      return
    }
    const wallId = name.slice(WALL_NAME_PREFIX.length)
    const w = plan.walls[wallId]
    if (!w) {
      setWallMenu(null)
      return
    }
    // keep an existing multi-selection if right-clicking within it; otherwise
    // select just this wall
    menuAutoSelRef.current = selection.includes(wallId) ? null : 'wall'
    if (!selection.includes(wallId)) select([wallId])
    const world = screenToWorld(ptr, viewport)
    let point = projectOnWall(world, w)
    // snap the split point to a nearby joint: an X crossing, or a T joint
    // where another wall's end lands on this wall's body — split exactly at
    // the abutting wall's centerline so both halves stay attached to it
    const worldR = 14 / viewport.scale
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
    const ux = (w.b.x - w.a.x) / len
    const uy = (w.b.y - w.a.y) / len
    let bestD = Infinity
    const consider = (x: Point) => {
      const d = Math.hypot(world.x - x.x, world.y - x.y)
      if (d <= worldR && d < bestD) {
        bestD = d
        point = x
      }
    }
    for (const c of Object.values(plan.walls)) {
      if (c.id === wallId) continue
      const x = segIntersect(w.a, w.b, c.a, c.b)
      if (x) consider(x)
      for (const p of [c.a, c.b]) {
        const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy
        const perp = Math.abs((p.x - w.a.x) * -uy + (p.y - w.a.y) * ux)
        if (t <= 1 || t >= len - 1) continue
        if (perp > w.thickness / 2 + c.thickness / 2 + 20) continue
        consider({ x: w.a.x + ux * t, y: w.a.y + uy * t })
      }
    }
    setWallMenu({ wallId, point, screen: ptr })
  }

  // endpoint handle dragging (from PlanLayer)
  const onEndpointDrag = (
    wallId: string,
    end: WallEnd,
    phase: 'start' | 'move' | 'end',
    e: KonvaEventObject<DragEvent>,
  ) => {
    if (phase === 'start') {
      beginDrag()
      return
    }
    if (phase === 'end') {
      endDrag()
      setSnapHint(null)
      return
    }
    // only this endpoint moves — connected walls do NOT follow
    const w = usePlanStore.getState().plan.walls[wallId]
    if (!w) return
    const other = end === 'a' ? w.b : w.a
    const world = screenToWorld({ x: e.target.x(), y: e.target.y() }, viewport)
    const s = snap(world, plan, viewport, {
      from: other,
      ortho: !e.evt.shiftKey,
      excludeWallIds: [wallId],
      snapEndpoints: true,
      snapWalls: true,
    })
    e.target.position(worldToScreen(s.point, viewport))
    setSnapHint(hintFrom(s))
    setEndpoints([{ wallId, end, point: s.point }])
  }

  const onEditDimension = (dim: Dimension, screen: Point) => {
    setDimEdit({ dim, screen, value: String(Math.round(dim.distance)), warn: null })
  }

  const commitDimEdit = () => {
    if (!dimEdit) return
    const v = parseFloat(dimEdit.value)
    if (!isFinite(v)) {
      setDimEdit({ ...dimEdit, warn: '숫자를 입력하세요.' })
      return
    }
    if (v < DIM_MIN_MM || v > DIM_MAX_MM) {
      setDimEdit({
        ...dimEdit,
        warn: `허용 범위(${DIM_MIN_MM}~${DIM_MAX_MM} mm)를 벗어났습니다.`,
      })
      return
    }
    // move the selected (clicked) wall toward/away from the facing wall, and
    // pull along its corner-connected walls (same as a wall-body drag)
    const d = dimEdit.dim
    const k = v / d.distance - 1
    const dx = (d.from.x - d.to.x) * k
    const dy = (d.from.y - d.to.y) * k
    const st = usePlanStore.getState()
    const w = st.wallProbe ? st.plan.walls[st.wallProbe.wallId] : null
    if (w) {
      const splits = splitJointEnds(st.plan, w)
      const attached = furnitureOnWall(st.plan, w)
      beginDrag()
      setEndpoints(
        collectMovers(st.plan, w).map((m) => ({
          wallId: m.wallId,
          end: m.end,
          point: { x: m.base.x + dx, y: m.base.y + dy },
        })),
      )
      for (const f of attached) {
        moveFurniture(f.id, { x: f.center.x + dx, y: f.center.y + dy })
      }
      bridgeSplitJoints(w.id, splits)
      endDrag()
    }
    setDimEdit(null)
  }

  const onEditOpeningDim = (
    id: string,
    side: 'low' | 'high',
    dist: number,
    screen: Point,
  ) => {
    setOpeningDimEdit({ id, side, screen, value: String(Math.round(dist)), warn: null })
  }

  const commitOpeningDim = () => {
    if (!openingDimEdit) return
    const { id, side, value } = openingDimEdit
    const op = plan.openings[id]
    if (!op) {
      setOpeningDimEdit(null)
      return
    }
    const v = parseFloat(value)
    if (!isFinite(v)) {
      setOpeningDimEdit({ ...openingDimEdit, warn: '숫자를 입력하세요.' })
      return
    }
    // same face-based reference as the displayed arrows
    const [lo, hi] = wallSegmentFacesAt(plan, op.wallId, op.position)
    const hw = op.width / 2
    // v is the distance to the opening centre
    const minD = Math.round(hw)
    const maxD = Math.round(hi - lo - hw)
    if (v < minD || v > maxD) {
      setOpeningDimEdit({ ...openingDimEdit, warn: `허용 범위(${minD}~${maxD} mm)` })
      return
    }
    const pos = side === 'low' ? lo + v : hi - v
    moveOpening(id, Math.max(lo + hw, Math.min(hi - hw, pos)))
    setOpeningDimEdit(null)
  }

  const commitGapEdit = () => {
    if (!gapEdit) return
    const f = plan.furniture?.[gapEdit.id]
    if (!f) {
      setGapEdit(null)
      return
    }
    const v = parseFloat(gapEdit.value)
    if (!isFinite(v) || v < 0) {
      setGapEdit({ ...gapEdit, warn: '0 이상의 숫자를 입력하세요.' })
      return
    }
    // moving along +n shrinks the gap by the same amount
    const delta = gapEdit.dist - v
    moveFurniture(gapEdit.id, {
      x: f.center.x + gapEdit.n.x * delta,
      y: f.center.y + gapEdit.n.y * delta,
    })
    setGapEdit(null)
  }

  // draft rubber-band geometry
  let draftLine: number[] | null = null
  let draftLabel: { x: number; y: number; text: string } | null = null
  if (draft) {
    const a = worldToScreen(draft.start.point, viewport)
    const b = worldToScreen(draft.end.point, viewport)
    draftLine = [a.x, a.y, b.x, b.y]
    const m = midpoint(a, b)
    draftLabel = {
      x: m.x - 30,
      y: m.y - 18,
      text: formatLength(distance(draft.start.point, draft.end.point)),
    }
  }

  const cursorScreen = cursor ? worldToScreen(cursor.point, viewport) : null

  // walls the context menu acts on (the selection, which always includes the
  // right-clicked wall)
  const menuTargets = selection.length
    ? selection
    : wallMenu
      ? [wallMenu.wallId]
      : []
  const menuOpening = doorMenu ? plan.openings[doorMenu.id] : null
  const styleOptions: [string, string][] =
    menuOpening?.type === 'window'
      ? [
          ['sliding', '슬라이딩'],
          ['turn', '여닫이'],
          ['awning', '어닝'],
          ['hung', '오르내리'],
          ['fix', '고정'],
        ]
      : [
          ['hinge', '여닫이'],
          ['pocket', '미닫이'],
          ['sliding', '미서기'],
          ['folding', '접이'],
        ]
  const curStyle =
    menuOpening?.style ?? (menuOpening?.type === 'window' ? 'sliding' : 'hinge')
  // size range is the wall SEGMENT around the opening (joint to joint), -100mm
  const menuSeg =
    menuOpening != null
      ? wallSegmentAt(plan, menuOpening.wallId, menuOpening.position)
      : ([0, 0] as [number, number])
  const sizeMin = 300
  const sizeMax = Math.max(sizeMin, Math.round(menuSeg[1] - menuSeg[0] - 100))
  // applies the size and returns the clamped width; the menu stays open
  const applyOpeningSize = (raw: string): number | null => {
    if (!doorMenu || !menuOpening) return null
    const v = parseFloat(raw)
    if (!isFinite(v)) return null
    const width = Math.min(sizeMax, Math.max(sizeMin, v))
    const [lo, hi] = menuSeg
    const position = Math.max(
      lo + width / 2,
      Math.min(hi - width / 2, menuOpening.position),
    )
    resizeOpening(doorMenu.id, width, position)
    return width
  }
  // furniture menu: apply one dimension, return the clamped value (menu stays open)
  const menuFurniture = furnMenu ? plan.furniture?.[furnMenu.id] : null
  // map a screen-space flip (좌우/상하) to the furniture's local axis: when the
  // piece is rotated ~90°, its width axis runs up-down on screen, so swap
  const furnFlipAxis = (dir: 'h' | 'v'): 'h' | 'v' => {
    if (!menuFurniture) return dir
    const r = ((menuFurniture.rotation % 180) + 180) % 180
    const vertical = r > 45 && r < 135
    return vertical ? (dir === 'h' ? 'v' : 'h') : dir
  }
  // Enter in either box applies BOTH width and depth as currently typed
  const applyFurnSizes = () => {
    if (!furnMenu || !menuFurniture) return
    const clamp = (raw: string | undefined, cur: number) => {
      const v = parseFloat(raw ?? '')
      return isFinite(v) ? Math.min(10000, Math.max(100, Math.round(v))) : cur
    }
    const wv = clamp(furnWRef.current?.value, menuFurniture.width)
    const dv = clamp(furnDRef.current?.value, menuFurniture.depth)
    resizeFurniture(furnMenu.id, wv, dv)
    if (furnWRef.current) furnWRef.current.value = String(wv)
    if (furnDRef.current) furnDRef.current.value = String(dv)
  }

  // current label of the room the room-menu is open for
  const roomMenuLabel = roomMenu
    ? Object.values(plan.rooms ?? {}).find((r) =>
        pointInPolygon(r.point, roomMenu.polygon),
      )
    : null

  // "문 추가 / 창 추가" from the wall menu: where (and whether) an opening
  // fits at the right-clicked point
  const menuAdd = (() => {
    const w = wallMenu ? plan.walls[wallMenu.wallId] : null
    if (!wallMenu || !w) return null
    if (w.transparent) return null // virtual walls carry no openings
    const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
    if (len < 1) return null
    const width = Math.min(900, len * 0.8)
    const cpos = Math.max(
      width / 2,
      Math.min(len - width / 2, snap10(wallPosOf(wallMenu.point, w))),
    )
    if (spanOverlapsOpening(w.id, cpos, width)) return null
    return { wallId: w.id, cpos, width }
  })()

  const addOpeningFromMenu = (type: OpeningType) => {
    if (!wallMenu || !menuAdd) return
    const id = addOpening(menuAdd.wallId, menuAdd.cpos, menuAdd.width, type)
    // the new opening stays selected after its menu closes
    menuAutoSelRef.current = null
    selectOpening(id)
    setDoorMenu({ id, screen: wallMenu.screen })
    setWallMenu(null)
  }

  // map a screen-space flip (좌우/상하) to the wall-relative flip axis:
  // on a (mostly) vertical wall the along-wall axis runs up-down, so swap
  const screenFlipAxis = (dir: 'h' | 'v'): 'h' | 'v' => {
    const w = menuOpening ? plan.walls[menuOpening.wallId] : undefined
    if (!w) return dir
    const vertical = Math.abs(w.b.y - w.a.y) > Math.abs(w.b.x - w.a.x)
    return vertical ? (dir === 'h' ? 'v' : 'h') : dir
  }

  const targetWalls = menuTargets.map((id) => plan.walls[id]).filter(Boolean)
  const allExterior =
    targetWalls.length > 0 && targetWalls.every((w) => w.kind === 'exterior')
  const allInterior =
    targetWalls.length > 0 && targetWalls.every((w) => w.kind === 'interior')
  const allTransparent =
    targetWalls.length > 0 && targetWalls.every((w) => w.transparent)

  // "벽 합치기" enabled when 2+ selected walls lie on the same line AND form a
  // contiguous run (touching, no gaps)
  const selWalls = selection.map((id) => plan.walls[id]).filter(Boolean)
  const canMergeSelection = (() => {
    if (selWalls.length < 2) return false
    const d0 = unitDir(selWalls[0])
    const n = { x: -d0.y, y: d0.x } // line normal
    const o = selWalls[0].a
    const intervals: [number, number][] = []
    for (const w of selWalls) {
      const d = unitDir(w)
      if (Math.abs(d.x * d0.y - d.y * d0.x) >= 0.02) return false // not parallel
      let lo = Infinity
      let hi = -Infinity
      for (const p of [w.a, w.b]) {
        if (Math.abs((p.x - o.x) * n.x + (p.y - o.y) * n.y) > 1) return false // off the line
        const t = (p.x - o.x) * d0.x + (p.y - o.y) * d0.y
        lo = Math.min(lo, t)
        hi = Math.max(hi, t)
      }
      intervals.push([lo, hi])
    }
    intervals.sort((a, b) => a[0] - b[0])
    let maxEnd = intervals[0][1]
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i][0] > maxEnd + 1) return false // gap > 1mm
      maxEnd = Math.max(maxEnd, intervals[i][1])
    }
    return true
  })()

  // clearance guides: a single selected furniture symbol shows the gap from
  // each edge midpoint, outward, to the nearest wall/furniture edge
  const gapGuides = (() => {
    if (tool !== 'select' || selection.length !== 1) return null
    const f = plan.furniture?.[selection[0]]
    if (!f) return null
    interface ORect {
      cx: number
      cy: number
      hw: number
      hd: number
      rot: number // radians
    }
    const obstacles: ORect[] = []
    for (const w of Object.values(plan.walls)) {
      if (w.transparent) continue
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
      if (len < 1) continue
      obstacles.push({
        cx: (w.a.x + w.b.x) / 2,
        cy: (w.a.y + w.b.y) / 2,
        hw: len / 2,
        hd: w.thickness / 2,
        rot: Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x),
      })
    }
    for (const o of Object.values(plan.furniture ?? {})) {
      if (o.id === f.id) continue
      obstacles.push({
        cx: o.center.x,
        cy: o.center.y,
        hw: o.width / 2,
        hd: o.depth / 2,
        rot: (o.rotation * Math.PI) / 180,
      })
    }
    // entry/exit distances along the ray (origin p, unit dir n) to the rect
    const rayHit = (
      p: Point,
      n: Point,
      r: ORect,
    ): { enter: number; exit: number } | null => {
      const c = Math.cos(r.rot)
      const s = Math.sin(r.rot)
      const px = (p.x - r.cx) * c + (p.y - r.cy) * s
      const py = -(p.x - r.cx) * s + (p.y - r.cy) * c
      const dx = n.x * c + n.y * s
      const dy = -n.x * s + n.y * c
      let t0 = -Infinity
      let t1 = Infinity
      for (const [d, o, h] of [
        [dx, px, r.hw],
        [dy, py, r.hd],
      ]) {
        if (Math.abs(d) < 1e-9) {
          if (Math.abs(o) > h) return null
        } else {
          const ta = (-h - o) / d
          const tb = (h - o) / d
          t0 = Math.max(t0, Math.min(ta, tb))
          t1 = Math.min(t1, Math.max(ta, tb))
          if (t0 > t1) return null
        }
      }
      return t1 < 0 ? null : { enter: t0, exit: t1 }
    }
    const cs = furnitureCorners(f)
    // an object fully enclosing f measures to its own edge (internal gap)
    const containsF = (r: ORect) => {
      const c = Math.cos(r.rot)
      const s = Math.sin(r.rot)
      return cs.every((p) => {
        const x = (p.x - r.cx) * c + (p.y - r.cy) * s
        const y = -(p.x - r.cx) * s + (p.y - r.cy) * c
        return Math.abs(x) <= r.hw + 2 && Math.abs(y) <= r.hd + 2
      })
    }
    const tagged = obstacles.map((r) => ({ r, contains: containsF(r) }))
    const out: { from: Point; to: Point; d: number; n: Point }[] = []
    for (let i = 0; i < 4; i++) {
      const c1 = cs[i]
      const c2 = cs[(i + 1) % 4]
      const mid = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 }
      const el = Math.hypot(c2.x - c1.x, c2.y - c1.y) || 1
      let n = { x: (c2.y - c1.y) / el, y: -(c2.x - c1.x) / el }
      if ((mid.x - f.center.x) * n.x + (mid.y - f.center.y) * n.y < 0)
        n = { x: -n.x, y: -n.y }
      let best = Infinity
      let blocked = false
      for (const { r, contains } of tagged) {
        const hit = rayHit(mid, n, r)
        if (!hit) continue
        if (contains) {
          best = Math.min(best, hit.exit) // gap to the container's edge
        } else if (hit.enter < 5) {
          blocked = true // touching/partly overlapping: no meaningful gap
          break
        } else {
          best = Math.min(best, hit.enter)
        }
      }
      if (!blocked && Number.isFinite(best) && best >= 5)
        out.push({
          from: mid,
          to: { x: mid.x + n.x * best, y: mid.y + n.y * best },
          d: best,
          n,
        })
    }
    return out
  })()

  return (
    <div ref={hostRef} className="canvas-host">
      <Stage
        width={size.width}
        height={size.height}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onContextMenu={onContextMenu}
        style={{
          cursor: wheelPan
            ? 'grabbing'
            : spacePan
              ? 'grab'
              : tool !== 'select'
                ? 'crosshair'
                : (hoverCursor ?? 'default'),
        }}
      >
        <Layer listening={false}>
          <Grid viewport={viewport} width={size.width} height={size.height} />
        </Layer>
        <Layer>
          <RoomFills viewport={viewport} />
          <OpeningRegions viewport={viewport} />
          <PlanLayer viewport={viewport} onEndpointDrag={onEndpointDrag} />
          {/* furniture sits above the wall/opening symbols (a bed in a door
              swing stays fully visible); room labels and dimension arrows go
              on top of it */}
          <FurnitureLayer viewport={viewport} />
          <RoomAnnotations viewport={viewport} />
          <DimensionLayer
            viewport={viewport}
            onEditDimension={onEditDimension}
            onEditOpeningDim={onEditOpeningDim}
          />

          {/* furniture placement ghost */}
          {tool === 'furniture' && furniturePick && furnGhost && (
            <FurnitureSymbol
              f={{
                kind: furniturePick.kind,
                center: furnGhost.center,
                width: furniturePick.width,
                depth: furniturePick.depth,
                rotation: furnGhost.rotation,
              }}
              viewport={viewport}
              stroke="#2f6df0"
              opacity={0.65}
            />
          )}

          {guide &&
            (() => {
              const f = worldToScreen(guide.from, viewport)
              const t = worldToScreen(guide.to, viewport)
              // extend the guide a touch past both endpoints
              const dx = t.x - f.x
              const dy = t.y - f.y
              const len = Math.hypot(dx, dy) || 1
              const ex = (dx / len) * 12
              const ey = (dy / len) * 12
              return (
                <>
                  <Line
                    points={[f.x - ex, f.y - ey, t.x + ex, t.y + ey]}
                    stroke="#ff5fd2"
                    strokeWidth={1}
                    dash={[5, 4]}
                    listening={false}
                  />
                  <Circle x={t.x} y={t.y} radius={4} stroke="#ff5fd2" strokeWidth={1.5} listening={false} />
                </>
              )
            })()}
          {draftLine && (
            <Line
              points={draftLine}
              stroke="#4f8cff"
              strokeWidth={2}
              dash={[8, 6]}
              listening={false}
            />
          )}
          {draftLabel && (
            <Text
              x={draftLabel.x}
              y={draftLabel.y}
              width={60}
              align="center"
              text={draftLabel.text}
              fontSize={12}
              fill="#2f6df0"
              listening={false}
            />
          )}
          {/* plain draw cursor (only when not snapped to anything notable) */}
          {isWallTool && cursorScreen && !cursor?.atEndpoint && !cursor?.onWall && (
            <Circle
              x={cursorScreen.x}
              y={cursorScreen.y}
              radius={5}
              stroke="#4f8cff"
              strokeWidth={2}
              listening={false}
            />
          )}
          {/* opening placement preview (ghost) */}
          {isOpeningTool &&
            doorPreview &&
            plan.walls[doorPreview.wallId] &&
            (() => {
              const g =
                doorPreview.type === 'window'
                  ? windowScreenGeometry(plan.walls[doorPreview.wallId], doorPreview, viewport)
                  : doorScreenGeometry(plan.walls[doorPreview.wallId], doorPreview, viewport)
              return (
                <Group listening={false} opacity={0.75}>
                  <Line
                    points={[g.gap[0].x, g.gap[0].y, g.gap[1].x, g.gap[1].y]}
                    stroke="#ffffff"
                    strokeWidth={g.wallPx + 2}
                    lineCap="butt"
                  />
                  {g.strokes.map((st, i) => (
                    <Line key={i} points={st.points} stroke="#2f6df0" strokeWidth={1.6} />
                  ))}
                </Group>
              )
            })()}

          {/* live size arrows + label while edge-resizing */}
          {sizeDragUi &&
            (() => {
              let pa: Point | null = null
              let pb: Point | null = null
              let size = 0
              if (sizeDragUi.kind === 'opening') {
                const op = plan.openings[sizeDragUi.id]
                const w = op ? plan.walls[op.wallId] : null
                if (!op || !w) return null
                const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
                const u = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len }
                pa = {
                  x: w.a.x + u.x * (op.position - op.width / 2),
                  y: w.a.y + u.y * (op.position - op.width / 2),
                }
                pb = {
                  x: w.a.x + u.x * (op.position + op.width / 2),
                  y: w.a.y + u.y * (op.position + op.width / 2),
                }
                size = op.width
              } else {
                const f = plan.furniture?.[sizeDragUi.id]
                if (!f) return null
                const r = (f.rotation * Math.PI) / 180
                const horizontal =
                  sizeDragUi.edge === 'left' || sizeDragUi.edge === 'right'
                const axis = horizontal
                  ? { x: Math.cos(r), y: Math.sin(r) }
                  : { x: -Math.sin(r), y: Math.cos(r) }
                size = horizontal ? f.width : f.depth
                pa = {
                  x: f.center.x - axis.x * (size / 2),
                  y: f.center.y - axis.y * (size / 2),
                }
                pb = {
                  x: f.center.x + axis.x * (size / 2),
                  y: f.center.y + axis.y * (size / 2),
                }
              }
              const a = worldToScreen(pa, viewport)
              const b = worldToScreen(pb, viewport)
              const label = `${Math.round(size)} mm`
              const boxW = label.length * 8 + 14
              const bx = (a.x + b.x) / 2 - boxW / 2
              const by = (a.y + b.y) / 2 - 10
              return (
                <Group listening={false}>
                  <Arrow
                    points={[a.x, a.y, b.x, b.y]}
                    pointerAtBeginning
                    pointerAtEnding
                    pointerLength={6}
                    pointerWidth={5}
                    stroke="#2f6df0"
                    fill="#2f6df0"
                    strokeWidth={0.75}
                  />
                  <Rect
                    x={bx}
                    y={by}
                    width={boxW}
                    height={20}
                    cornerRadius={4}
                    fill="rgba(255,255,255,0.92)"
                    stroke="#2f6df0"
                    strokeWidth={0.75}
                  />
                  <Text
                    x={bx}
                    y={by + 4}
                    width={boxW}
                    align="center"
                    text={label}
                    fontSize={13}
                    fill="#2f6df0"
                  />
                </Group>
              )
            })()}

          {/* clearance to the nearest object on each side of the selection —
              same look as the opening dimensions; click the label to edit */}
          {gapGuides?.map((g, i) => {
            const a = worldToScreen(g.from, viewport)
            const b = worldToScreen(g.to, viewport)
            const label = `${Math.round(g.d)}`
            const boxW = label.length * 8 + 14
            const bx = (a.x + b.x) / 2 - boxW / 2
            const by = (a.y + b.y) / 2 - 9
            const setCur = (e: KonvaEventObject<MouseEvent>, v: string) => {
              const c = e.target.getStage()?.container()
              if (c) c.style.cursor = v
            }
            return (
              <Group
                key={`gap${i}`}
                onMouseEnter={(e) => setCur(e, 'pointer')}
                onMouseLeave={(e) => setCur(e, '')}
                onMouseDown={(e) => {
                  e.cancelBubble = true // keep Canvas from drag/deselect
                }}
                onClick={(e) => {
                  e.cancelBubble = true
                  setGapEdit({
                    id: selection[0],
                    n: g.n,
                    dist: g.d,
                    screen: { x: bx, y: by },
                    value: String(Math.round(g.d)),
                    warn: null,
                  })
                }}
              >
                <Arrow
                  points={[a.x, a.y, b.x, b.y]}
                  pointerAtBeginning
                  pointerAtEnding
                  pointerLength={6}
                  pointerWidth={5}
                  stroke="#e07c0a"
                  fill="#e07c0a"
                  strokeWidth={0.75}
                  listening={false}
                />
                <Rect
                  x={bx}
                  y={by}
                  width={boxW}
                  height={18}
                  cornerRadius={4}
                  fill="rgba(255,255,255,0.92)"
                  stroke="#e07c0a"
                  strokeWidth={0.75}
                />
                <Text
                  x={bx}
                  y={by + 3}
                  width={boxW}
                  align="center"
                  text={label}
                  fontSize={12}
                  fill="#e07c0a"
                />
              </Group>
            )
          })}

          {/* rubber-band selection rectangle */}
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              stroke="#2f6df0"
              strokeWidth={1}
              dash={[6, 4]}
              fill="rgba(47,109,240,0.08)"
              listening={false}
            />
          )}

          {/* prominent pink snap marker — endpoint snap or T/wall snap, any mode */}
          {snapHint &&
            (() => {
              const p = worldToScreen(snapHint.point, viewport)
              return (
                <>
                  <Circle
                    x={p.x}
                    y={p.y}
                    radius={10}
                    stroke="#ff2e9a"
                    strokeWidth={2.5}
                    listening={false}
                  />
                  <Circle
                    x={p.x}
                    y={p.y}
                    radius={3}
                    fill="#ff2e9a"
                    listening={false}
                  />
                  {snapHint.kind === 'wall' && (
                    <Circle
                      x={p.x}
                      y={p.y}
                      radius={10}
                      stroke="#ff2e9a"
                      strokeWidth={1}
                      dash={[3, 3]}
                      scaleX={1.6}
                      scaleY={1.6}
                      listening={false}
                    />
                  )}
                </>
              )
            })()}
        </Layer>
      </Stage>

      {dimEdit && (
        <div
          className="dim-edit"
          style={{ left: dimEdit.screen.x, top: dimEdit.screen.y }}
        >
          <div className="dim-edit-row">
            <input
              autoFocus
              type="number"
              onFocus={(e) => e.target.select()}
              value={dimEdit.value}
              onChange={(e) =>
                setDimEdit({ ...dimEdit, value: e.target.value, warn: null })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDimEdit()
                else if (e.key === 'Escape') setDimEdit(null)
              }}
              onBlur={() => setDimEdit(null)}
            />
            <span className="unit">mm</span>
          </div>
          {dimEdit.warn && <div className="dim-warn">{dimEdit.warn}</div>}
        </div>
      )}

      {openingDimEdit && (
        <div
          className="dim-edit"
          style={{ left: openingDimEdit.screen.x, top: openingDimEdit.screen.y }}
        >
          <div className="dim-edit-row">
            <input
              autoFocus
              type="number"
              onFocus={(e) => e.target.select()}
              value={openingDimEdit.value}
              onChange={(e) =>
                setOpeningDimEdit({ ...openingDimEdit, value: e.target.value, warn: null })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitOpeningDim()
                else if (e.key === 'Escape') setOpeningDimEdit(null)
              }}
              onBlur={() => setOpeningDimEdit(null)}
            />
            <span className="unit">mm</span>
          </div>
          {openingDimEdit.warn && <div className="dim-warn">{openingDimEdit.warn}</div>}
        </div>
      )}

      {gapEdit && (
        <div
          className="dim-edit"
          style={{ left: gapEdit.screen.x, top: gapEdit.screen.y }}
        >
          <div className="dim-edit-row">
            <input
              autoFocus
              type="number"
              step={10}
              onFocus={(e) => e.target.select()}
              value={gapEdit.value}
              onChange={(e) =>
                setGapEdit({ ...gapEdit, value: e.target.value, warn: null })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGapEdit()
                else if (e.key === 'Escape') setGapEdit(null)
              }}
              onBlur={() => setGapEdit(null)}
            />
            <span className="unit">mm</span>
          </div>
          {gapEdit.warn && <div className="dim-warn">{gapEdit.warn}</div>}
        </div>
      )}

      {wallMenu && (
        <div
          className="ctx-backdrop"
          onMouseDown={() => closeCtxMenus()}
          onContextMenu={(e) => {
            e.preventDefault()
            closeCtxMenus()
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: wallMenu.screen.x, top: wallMenu.screen.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                splitWall(wallMenu.wallId, wallMenu.point)
                closeCtxMenus()
              }}
            >
              여기서 분할
            </button>
            <button disabled={!menuAdd} onClick={() => addOpeningFromMenu('door')}>
              문 추가
            </button>
            <button disabled={!menuAdd} onClick={() => addOpeningFromMenu('window')}>
              창 추가
            </button>
            <button
              disabled={!canMergeSelection}
              onClick={() => {
                mergeWalls(selection)
                closeCtxMenus()
              }}
            >
              벽 합치기
            </button>
            <button
              disabled={allExterior}
              onClick={() => {
                setWallKind(menuTargets, 'exterior')
                closeCtxMenus()
              }}
            >
              외벽으로 (300mm)
            </button>
            <button
              disabled={allInterior}
              onClick={() => {
                setWallKind(menuTargets, 'interior')
                closeCtxMenus()
              }}
            >
              내벽으로 (200mm)
            </button>
            <button
              onClick={() => {
                setWallTransparent(menuTargets, !allTransparent)
                closeCtxMenus()
              }}
            >
              {allTransparent ? '일반벽으로' : '투명벽으로'}
            </button>
            <button
              onClick={() => {
                deleteWalls(menuTargets)
                closeCtxMenus()
              }}
            >
              벽 삭제
            </button>
          </div>
        </div>
      )}

      {doorMenu && (
        <div
          className="ctx-backdrop"
          onMouseDown={() => closeCtxMenus()}
          onContextMenu={(e) => {
            e.preventDefault()
            closeCtxMenus()
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: doorMenu.screen.x, top: doorMenu.screen.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="ctx-sizes">
              <span>크기</span>
              <input
                key={doorMenu.id}
                type="number"
                step={10}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                defaultValue={Math.round(menuOpening?.width ?? 0)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const w = applyOpeningSize(e.currentTarget.value)
                    if (w != null) e.currentTarget.value = String(w)
                  } else if (e.key === 'Escape') closeCtxMenus()
                }}
              />
              <span className="unit">mm</span>
            </div>
            <div className="ctx-hint">
              {sizeMin}~{sizeMax} mm · Enter로 적용
            </div>
            <div className="ctx-sizes">
              <span>종류</span>
              {styleOptions.map(([st, label]) => (
                <button
                  key={st}
                  className={curStyle === st ? 'active' : ''}
                  onClick={() => setOpeningStyle(doorMenu.id, st as OpeningStyle)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => toggleOpeningFlip(doorMenu.id, screenFlipAxis('h'))}>
              좌우 반전
            </button>
            <button onClick={() => toggleOpeningFlip(doorMenu.id, screenFlipAxis('v'))}>
              상하 반전
            </button>
            <button
              onClick={() => {
                removeOpening(doorMenu.id)
                closeCtxMenus()
              }}
            >
              {menuOpening?.type === 'window' ? '창 삭제' : '문 삭제'}
            </button>
          </div>
        </div>
      )}

      {multiMenu &&
        (() => {
          // furniture-only selections also rotate/flip as a group (about the
          // bbox center); mixed selections only delete
          const furnPieces = selection
            .map((id) => plan.furniture?.[id])
            .filter(Boolean)
          const allFurn =
            furnPieces.length > 0 && furnPieces.length === selection.length
          const box = allFurn ? furnitureBBox(furnPieces) : null
          const pivot = box
            ? {
                x: (box.minX + box.maxX) / 2,
                y: (box.minY + box.maxY) / 2,
              }
            : null
          const furnIds = furnPieces.map((f) => f.id)
          return (
            <div
              className="ctx-backdrop"
              onMouseDown={() => closeCtxMenus()}
              onContextMenu={(e) => {
                e.preventDefault()
                closeCtxMenus()
              }}
            >
              <div
                className="ctx-menu"
                style={{ left: multiMenu.screen.x, top: multiMenu.screen.y }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {pivot && (
                  <div className="ctx-icons">
                    <button
                      title="좌로 회전"
                      onClick={() => rotateFurnitureGroup(furnIds, -1, pivot)}
                    >
                      <RotateGlyph dir="l" />
                    </button>
                    <button
                      title="우로 회전"
                      onClick={() => rotateFurnitureGroup(furnIds, 1, pivot)}
                    >
                      <RotateGlyph dir="r" />
                    </button>
                    <button
                      title="좌우 반전"
                      onClick={() => flipFurnitureGroup(furnIds, 'h', pivot)}
                    >
                      <FlipGlyph axis="h" />
                    </button>
                    <button
                      title="상하 반전"
                      onClick={() => flipFurnitureGroup(furnIds, 'v', pivot)}
                    >
                      <FlipGlyph axis="v" />
                    </button>
                  </div>
                )}
                {furnIds.length >= 2 &&
                  (
                    [
                      [
                        ['left', '왼쪽 맞춤'],
                        ['centerX', '가운데 맞춤'],
                        ['right', '오른쪽 맞춤'],
                      ],
                      [
                        ['top', '위 맞춤'],
                        ['centerY', '중간 맞춤'],
                        ['bottom', '아래 맞춤'],
                      ],
                    ] as const
                  ).map((row, ri) => (
                    <div className="ctx-icons" key={`al${ri}`}>
                      {row.map(([mode, title]) => (
                        <button
                          key={mode}
                          title={title}
                          onClick={() => alignFurniture(furnIds, mode)}
                        >
                          <AlignGlyph mode={mode} />
                        </button>
                      ))}
                    </div>
                  ))}
                <button
                  onClick={() => {
                    deleteObjects(selection)
                    closeCtxMenus()
                  }}
                >
                  삭제 ({selection.length}개)
                </button>
              </div>
            </div>
          )
        })()}

      {furnMenu && menuFurniture && (
        <div
          className="ctx-backdrop"
          onMouseDown={() => closeCtxMenus()}
          onContextMenu={(e) => {
            e.preventDefault()
            closeCtxMenus()
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: furnMenu.screen.x, top: furnMenu.screen.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">
              {FURNITURE_KIND_LABELS[menuFurniture.kind]}
            </div>
            <div className="ctx-sizes">
              <span>폭</span>
              <input
                key={`w-${furnMenu.id}`}
                ref={furnWRef}
                type="number"
                step={10}
                defaultValue={Math.round(menuFurniture.width)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFurnSizes()
                  else if (e.key === 'Escape') closeCtxMenus()
                }}
              />
              <span className="unit">mm</span>
            </div>
            <div className="ctx-sizes">
              <span>깊이</span>
              <input
                key={`d-${furnMenu.id}`}
                ref={furnDRef}
                type="number"
                step={10}
                defaultValue={Math.round(menuFurniture.depth)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFurnSizes()
                  else if (e.key === 'Escape') closeCtxMenus()
                }}
              />
              <span className="unit">mm</span>
            </div>
            <div className="ctx-hint">100~10000 mm · Enter로 적용</div>
            <div className="ctx-icons">
              <button title="좌로 회전" onClick={() => rotateFurniture(furnMenu.id, -90)}>
                <RotateGlyph dir="l" />
              </button>
              <button title="우로 회전" onClick={() => rotateFurniture(furnMenu.id, 90)}>
                <RotateGlyph dir="r" />
              </button>
              <button title="좌우 반전" onClick={() => flipFurniture(furnMenu.id, furnFlipAxis('h'))}>
                <FlipGlyph axis="h" />
              </button>
              <button title="상하 반전" onClick={() => flipFurniture(furnMenu.id, furnFlipAxis('v'))}>
                <FlipGlyph axis="v" />
              </button>
            </div>
            <button onClick={() => bringFurnitureToFront(furnMenu.id)}>
              맨 앞으로
            </button>
            <button
              onClick={() => {
                deleteObjects([furnMenu.id])
                closeCtxMenus()
              }}
            >
              삭제
            </button>
          </div>
        </div>
      )}

      {roomMenu && (
        <div
          className="ctx-backdrop"
          onMouseDown={() => closeCtxMenus()}
          onContextMenu={(e) => {
            e.preventDefault()
            closeCtxMenus()
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: roomMenu.screen.x, top: roomMenu.screen.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="ctx-sizes">
              <span>방 종류</span>
            </div>
            <div className="ctx-rooms">
              {(Object.keys(ROOM_KIND_LABELS) as RoomKind[])
                .sort((a, b) => (a === 'etc' ? 1 : 0) - (b === 'etc' ? 1 : 0))
                .map((k) => (
                <button
                  key={k}
                  className={roomMenuLabel?.kind === k ? 'active' : ''}
                  onClick={() =>
                    setRoomKind(
                      roomMenu.polygon,
                      roomMenu.anchor,
                      k,
                      k === 'etc' ? roomMenuLabel?.name : undefined,
                    )
                  }
                >
                  {ROOM_KIND_LABELS[k]}
                </button>
              ))}
            </div>
            {roomMenuLabel?.kind === 'etc' && (
              <div className="ctx-sizes">
                <span>이름</span>
                <input
                  key={roomMenuLabel.id}
                  className="room-name"
                  autoFocus
                  defaultValue={roomMenuLabel.name ?? ''}
                  placeholder="직접 입력"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setRoomKind(
                        roomMenu.polygon,
                        roomMenu.anchor,
                        'etc',
                        e.currentTarget.value.trim(),
                      )
                      closeCtxMenus()
                    } else if (e.key === 'Escape') closeCtxMenus()
                  }}
                  onBlur={(e) => {
                    // commit on blur too, so closing the menu keeps the name
                    const v = e.currentTarget.value.trim()
                    if (v !== (roomMenuLabel.name ?? ''))
                      setRoomKind(roomMenu.polygon, roomMenu.anchor, 'etc', v)
                  }}
                />
              </div>
            )}
            <label className="ctx-check">
              <input
                type="checkbox"
                checked={!!roomMenuLabel?.excludeArea}
                onChange={() =>
                  toggleRoomExcludeArea(roomMenu.polygon, roomMenu.anchor)
                }
              />
              면적에서 제외
            </label>
          </div>
        </div>
      )}

    </div>
  )
}
