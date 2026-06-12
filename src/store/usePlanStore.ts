import { create } from 'zustand'
import { temporal } from 'zundo'
import { immer } from 'zustand/middleware/immer'
import {
  WALL_THICKNESS,
  emptyPlan,
  type FloorPlan,
  type FurnitureKind,
  type FurniturePreset,
  type OpeningPick,
  type OpeningStyle,
  type OpeningType,
  type Point,
  type RoomKind,
  type WallEnd,
  type WallKind,
  type WallPick,
  DOOR_PICKS,
  WALL_PICKS,
  WINDOW_PICKS,
} from '../types/model'
import { pointInPolygon } from '../geometry/rooms'
import { furnitureCorners } from '../geometry/furniture'

export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'

const uid = () => crypto.randomUUID()

export type ToolId = 'select' | 'wall' | 'door' | 'window' | 'furniture'

/** A parametric point on a wall (t in 0..1 from a to b) where the user clicked
 *  to request perpendicular dimension arrows. Follows the wall as it moves. */
export interface WallProbe {
  wallId: string
  t: number
}

interface PlanState {
  plan: FloorPlan
  // --- transient UI state (excluded from undo history) ---
  tool: ToolId
  selection: string[] // selected wall AND opening ids, in selection order
  selectedOpening: string | null // the single selected door/window (derived from selection)
  wallProbe: WallProbe | null
  roomPick: Point | null // a clicked point; the room containing it shows its area
  furniturePick: FurniturePreset | null // the kind being placed (furniture tool)
  wallPick: WallPick // the wall variant being drawn (wall tool)
  doorPick: OpeningPick // the door variant being placed (door tool)
  windowPick: OpeningPick // the window variant being placed (window tool)
  showDims: boolean // auto dimension lines along exterior walls
  debug: boolean
  marqueeSize: { w: number; h: number } | null // live rubber-band size (mm)

  setTool: (t: ToolId) => void
  setFurniturePick: (preset: FurniturePreset | null) => void
  setWallPick: (pick: WallPick) => void
  setOpeningPick: (pick: OpeningPick) => void
  setMarqueeSize: (size: { w: number; h: number } | null) => void
  select: (ids: string[]) => void
  toggleSelect: (id: string) => void // ctrl-click add/remove (wall or opening)
  selectOpening: (id: string | null) => void
  setWallProbe: (probe: WallProbe | null) => void
  setRoomPick: (point: Point | null) => void
  toggleDims: () => void
  toggleDebug: () => void

  /** Create a wall between two points. Returns the new wall id (or '' if zero). */
  commitWall: (a: Point, b: Point, kind: WallKind, transparent?: boolean) => string
  /** Move one endpoint of a wall. */
  moveWallEndpoint: (wallId: string, end: WallEnd, point: Point) => void
  /** Set absolute positions for several wall endpoints at once (joint drag). */
  setEndpoints: (updates: { wallId: string; end: WallEnd; point: Point }[]) => void
  /** Translate both endpoints of a wall by (dx, dy). */
  translateWall: (wallId: string, dx: number, dy: number) => void
  /** Split a wall in two at `point`. */
  splitWall: (wallId: string, point: Point) => void
  /** Merge several (collinear) walls into one spanning wall. */
  mergeWalls: (ids: string[]) => void
  /** Set the kind (and matching thickness) of several walls. */
  setWallKind: (ids: string[], kind: WallKind) => void
  /** Make several walls transparent (virtual) or solid. */
  setWallTransparent: (ids: string[], transparent: boolean) => void
  deleteWalls: (ids: string[]) => void
  /** Delete a mixed set of walls, openings and furniture in one undo step. */
  deleteObjects: (ids: string[]) => void
  /** Clone a wall (with its openings), an opening or a furniture in place —
   *  used by Ctrl+drag copy. Returns the new id, or null. */
  duplicateObject: (id: string) => string | null

  /** Add a piece of furniture. Returns the new id. */
  addFurniture: (
    kind: FurnitureKind,
    center: Point,
    width: number,
    depth: number,
    rotation: number,
  ) => string
  /** Move a piece of furniture (rotation updated only when given). */
  moveFurniture: (id: string, center: Point, rotation?: number) => void
  /** Set a furniture's width/depth (center kept). */
  resizeFurniture: (id: string, width: number, depth: number) => void
  /** Rotate a furniture by `delta` degrees. */
  rotateFurniture: (id: string, delta: number) => void
  /** Mirror a furniture along its local width (h) or depth (v) axis. */
  flipFurniture: (id: string, axis: 'h' | 'v') => void
  /** Rotate several furniture pieces ±90° about a pivot (one undo step). */
  rotateFurnitureGroup: (ids: string[], dir: 1 | -1, pivot: Point) => void
  /** Mirror several furniture pieces across a screen axis through `pivot`. */
  flipFurnitureGroup: (ids: string[], axis: 'h' | 'v', pivot: Point) => void
  /** Align furniture AABBs to the selection's bounding box edge/centre. */
  alignFurniture: (ids: string[], mode: AlignMode) => void
  /** Re-stack a furniture above all others. */
  bringFurnitureToFront: (id: string) => void

  /** Assign a kind to the room bounded by `polygon`; the label is anchored
   *  at `anchor` (a point inside the room). Replaces any existing label. */
  setRoomKind: (
    polygon: Point[],
    anchor: Point,
    kind: RoomKind,
    name?: string,
  ) => void
  /** Toggle "exclude from total area" for the room bounded by `polygon`. */
  toggleRoomExcludeArea: (polygon: Point[], anchor: Point) => void

  /** Add an opening (door/window) on a wall. Returns the new opening id. */
  addOpening: (
    wallId: string,
    position: number,
    width: number,
    type: OpeningType,
    style?: OpeningStyle,
  ) => string
  /** Move an opening along its wall (position = mm from endpoint a). */
  moveOpening: (id: string, position: number) => void
  /** Flip a door's hinge (h) or swing (v) direction. */
  toggleOpeningFlip: (id: string, axis: 'h' | 'v') => void
  /** Set a door's flip flags directly (used while placing). */
  setOpeningFlips: (id: string, flipH: boolean, flipV: boolean) => void
  /** Set an opening's width (clamped to its wall, position kept in bounds). */
  setOpeningWidth: (id: string, width: number) => void
  /** Set an opening's width and position together (single change). */
  resizeOpening: (id: string, width: number, position: number) => void
  /** Set a door's leaf style. */
  setOpeningStyle: (id: string, style: OpeningStyle) => void
  removeOpening: (id: string) => void

  clear: () => void
  loadPlan: (plan: FloorPlan) => void
  /** Replace the plan without touching selection — used by drag history. */
  restorePlan: (plan: FloorPlan) => void
}

export const usePlanStore = create<PlanState>()(
  temporal(
    immer((set) => ({
      plan: emptyPlan(),
      tool: 'wall',
      selection: [],
      selectedOpening: null,
      wallProbe: null,
      roomPick: null,
      furniturePick: null,
      wallPick: WALL_PICKS[0],
      doorPick: DOOR_PICKS[0],
      windowPick: WINDOW_PICKS[0],
      showDims: false,
      debug: false,
      marqueeSize: null,

      setTool: (t) =>
        set((s) => {
          s.tool = t
          s.selection = []
          s.selectedOpening = null
          s.wallProbe = null
          s.roomPick = null
        }),

      setFurniturePick: (preset) =>
        set((s) => {
          s.furniturePick = preset
        }),

      setWallPick: (pick) =>
        set((s) => {
          s.wallPick = pick
        }),

      setOpeningPick: (pick) =>
        set((s) => {
          if (pick.type === 'door') s.doorPick = pick
          else s.windowPick = pick
        }),

      setMarqueeSize: (size) =>
        set((s) => {
          s.marqueeSize = size
        }),

      select: (ids) =>
        set((s) => {
          s.selection = ids
          s.selectedOpening =
            ids.length === 1 && s.plan.openings[ids[0]] ? ids[0] : null
          s.wallProbe = null
          s.roomPick = null
        }),

      selectOpening: (id) =>
        set((s) => {
          s.selectedOpening = id
          s.selection = id ? [id] : []
          s.wallProbe = null
          s.roomPick = null
        }),

      toggleSelect: (id) =>
        set((s) => {
          s.selection = s.selection.includes(id)
            ? s.selection.filter((x) => x !== id)
            : [...s.selection, id]
          s.selectedOpening =
            s.selection.length === 1 && s.plan.openings[s.selection[0]]
              ? s.selection[0]
              : null
          s.wallProbe = null
          s.roomPick = null
        }),

      setWallProbe: (probe) =>
        set((s) => {
          s.wallProbe = probe
        }),

      setRoomPick: (point) =>
        set((s) => {
          s.roomPick = point
        }),

      toggleDims: () =>
        set((s) => {
          s.showDims = !s.showDims
        }),

      toggleDebug: () =>
        set((s) => {
          s.debug = !s.debug
        }),

      commitWall: (a, b, kind, transparent) => {
        if (a.x === b.x && a.y === b.y) return ''
        const id = uid()
        set((s) => {
          // drawing over a collinear wall replaces the covered span: the old
          // wall is split at the new wall's ends and its middle removed —
          // openings in the middle move onto the new wall
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
          const LAT = 5 // max centreline offset (mm) to count as overlapping
          for (const w of [...Object.values(s.plan.walls)]) {
            const tA = (w.a.x - a.x) * u.x + (w.a.y - a.y) * u.y
            const tB = (w.b.x - a.x) * u.x + (w.b.y - a.y) * u.y
            const latA = (w.a.y - a.y) * u.x - (w.a.x - a.x) * u.y
            const latB = (w.b.y - a.y) * u.x - (w.b.x - a.x) * u.y
            if (Math.abs(latA) > LAT || Math.abs(latB) > LAT) continue
            const lo = Math.max(0, Math.min(tA, tB))
            const hi = Math.min(len, Math.max(tA, tB))
            if (hi - lo <= 1) continue // touching end-to-end only
            // covered span in w's own coordinates (measured from w.a)
            const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
            const wu = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L }
            const onW = (t: number) => {
              const p = { x: a.x + u.x * t, y: a.y + u.y * t }
              return (p.x - w.a.x) * wu.x + (p.y - w.a.y) * wu.y
            }
            const c1 = Math.min(onW(lo), onW(hi))
            const c2 = Math.max(onW(lo), onW(hi))
            // remainder pieces outside the covered span keep w's properties
            const flag = w.transparent ? { transparent: true as const } : {}
            const piece = (pa: Point, pb: Point) => {
              const pid = uid()
              s.plan.walls[pid] = {
                id: pid,
                a: pa,
                b: pb,
                thickness: w.thickness,
                kind: w.kind,
                ...flag,
              }
              return pid
            }
            const id1 =
              c1 > 1
                ? piece(
                    { ...w.a },
                    { x: w.a.x + wu.x * c1, y: w.a.y + wu.y * c1 },
                  )
                : null
            const id2 =
              L - c2 > 1
                ? piece(
                    { x: w.a.x + wu.x * c2, y: w.a.y + wu.y * c2 },
                    { ...w.b },
                  )
                : null
            for (const o of Object.values(s.plan.openings)) {
              if (o.wallId !== w.id) continue
              const hw = o.width / 2
              if (id1 && o.position <= c1) {
                if (c1 < o.width) delete s.plan.openings[o.id]
                else {
                  o.wallId = id1
                  o.position = Math.max(hw, Math.min(c1 - hw, o.position))
                }
              } else if (id2 && o.position >= c2) {
                if (L - c2 < o.width) delete s.plan.openings[o.id]
                else {
                  o.wallId = id2
                  o.position = Math.max(
                    hw,
                    Math.min(L - c2 - hw, o.position - c2),
                  )
                }
              } else if (transparent) {
                delete s.plan.openings[o.id] // transparent walls hold none
              } else {
                // centre fell in the replaced middle: move to the new wall
                const c = {
                  x: w.a.x + wu.x * o.position,
                  y: w.a.y + wu.y * o.position,
                }
                const t = (c.x - a.x) * u.x + (c.y - a.y) * u.y
                o.wallId = id
                o.position = Math.max(hw, Math.min(len - hw, t))
              }
            }
            delete s.plan.walls[w.id]
          }
          s.plan.walls[id] = {
            id,
            a: { ...a },
            b: { ...b },
            thickness: WALL_THICKNESS[kind],
            kind,
            ...(transparent ? { transparent: true } : {}),
          }
        })
        return id
      },

      moveWallEndpoint: (wallId, end, point) =>
        set((s) => {
          const w = s.plan.walls[wallId]
          if (w) w[end] = { ...point }
        }),

      setEndpoints: (updates) =>
        set((s) => {
          // record which ends move per wall + each wall's old length
          const moved = new Map<
            string,
            { a: boolean; b: boolean; oldLen: number }
          >()
          for (const u of updates) {
            const w = s.plan.walls[u.wallId]
            if (!w) continue
            let m = moved.get(u.wallId)
            if (!m) {
              m = {
                a: false,
                b: false,
                oldLen: Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y),
              }
              moved.set(u.wallId, m)
            }
            m[u.end] = true
          }
          for (const u of updates) {
            const w = s.plan.walls[u.wallId]
            if (w) w[u.end] = { ...u.point }
          }
          // when a wall is reshaped (only one end moved), keep its openings put
          // by measuring from the end that didn't move
          for (const o of Object.values(s.plan.openings)) {
            const m = moved.get(o.wallId)
            if (!m || (m.a && m.b)) continue // none, or rigid move → follow wall
            const w = s.plan.walls[o.wallId]
            if (!w) continue
            const newLen = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
            const hw = o.width / 2
            if (m.a) o.position = newLen - (m.oldLen - o.position) // a moved, b fixed
            o.position = Math.max(hw, Math.min(newLen - hw, o.position))
          }
        }),

      translateWall: (wallId, dx, dy) =>
        set((s) => {
          const w = s.plan.walls[wallId]
          if (!w) return
          w.a = { x: w.a.x + dx, y: w.a.y + dy }
          w.b = { x: w.b.x + dx, y: w.b.y + dy }
        }),

      splitWall: (wallId, point) =>
        set((s) => {
          const w = s.plan.walls[wallId]
          if (!w) return
          const { a, b, thickness, kind, transparent } = w
          const t = Math.hypot(point.x - a.x, point.y - a.y)
          const total = Math.hypot(b.x - a.x, b.y - a.y)
          const id1 = uid()
          const id2 = uid()
          // keep openings: each goes to the side its centre falls on (one
          // straddling the split point is pushed fully onto that side)
          for (const o of Object.values(s.plan.openings)) {
            if (o.wallId !== wallId) continue
            const first = o.position < t
            const childLen = first ? t : total - t
            if (childLen < o.width) {
              delete s.plan.openings[o.id] // doesn't fit on its side
              continue
            }
            const hw = o.width / 2
            const pos = first ? o.position : o.position - t
            o.wallId = first ? id1 : id2
            o.position = Math.max(hw, Math.min(childLen - hw, pos))
          }
          delete s.plan.walls[wallId]
          const flag = transparent ? { transparent: true as const } : {}
          s.plan.walls[id1] = { id: id1, a: { ...a }, b: { ...point }, thickness, kind, ...flag }
          s.plan.walls[id2] = { id: id2, a: { ...point }, b: { ...b }, thickness, kind, ...flag }
          s.selection = []
          s.wallProbe = null
        }),

      mergeWalls: (ids) =>
        set((s) => {
          const walls = ids.map((id) => s.plan.walls[id]).filter(Boolean)
          if (walls.length < 2) return
          // span the extreme endpoints along the first wall's direction
          const w0 = walls[0]
          let dx = w0.b.x - w0.a.x
          let dy = w0.b.y - w0.a.y
          const dlen = Math.hypot(dx, dy) || 1
          dx /= dlen
          dy /= dlen
          const o = w0.a
          let minT = Infinity
          let maxT = -Infinity
          let minP = o
          let maxP = o
          for (const w of walls) {
            for (const p of [w.a, w.b]) {
              const t = (p.x - o.x) * dx + (p.y - o.y) * dy
              if (t < minT) {
                minT = t
                minP = p
              }
              if (t > maxT) {
                maxT = t
                maxP = p
              }
            }
          }
          // keep kind/thickness consistent: exterior wins, thickness follows
          // kind; the result is transparent only if every part was
          const kind = walls.some((w) => w.kind === 'exterior')
            ? 'exterior'
            : 'interior'
          const transparent = walls.every((w) => w.transparent)
          // keep openings: remember world centres, re-anchor on the new wall
          const kept: { o: (typeof s.plan.openings)[string]; c: Point }[] = []
          for (const id of ids) {
            for (const op of Object.values(s.plan.openings)) {
              if (op.wallId !== id) continue
              const w = s.plan.walls[id]
              const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1
              kept.push({
                o: op,
                c: {
                  x: w.a.x + ((w.b.x - w.a.x) / len) * op.position,
                  y: w.a.y + ((w.b.y - w.a.y) / len) * op.position,
                },
              })
            }
            delete s.plan.walls[id]
          }
          const nid = uid()
          s.plan.walls[nid] = {
            id: nid,
            a: { ...minP },
            b: { ...maxP },
            thickness: WALL_THICKNESS[kind],
            kind,
            ...(transparent ? { transparent: true } : {}),
          }
          const newLen = maxT - minT
          for (const { o, c } of kept) {
            const hw = o.width / 2
            o.wallId = nid
            o.position = Math.max(
              hw,
              Math.min(
                newLen - hw,
                (c.x - minP.x) * dx + (c.y - minP.y) * dy,
              ),
            )
          }
          s.selection = [nid]
          s.wallProbe = null
        }),

      setWallKind: (ids, kind) =>
        set((s) => {
          for (const id of ids) {
            const w = s.plan.walls[id]
            if (w) {
              w.kind = kind
              w.thickness = WALL_THICKNESS[kind]
            }
          }
        }),

      setWallTransparent: (ids, transparent) =>
        set((s) => {
          for (const id of ids) {
            const w = s.plan.walls[id]
            if (!w) continue
            if (transparent) w.transparent = true
            else delete w.transparent
            // a virtual wall cannot carry doors/windows
            if (transparent) {
              for (const o of Object.values(s.plan.openings)) {
                if (o.wallId === id) delete s.plan.openings[o.id]
              }
            }
          }
        }),

      addOpening: (wallId, position, width, type, style) => {
        const id = uid()
        set((s) => {
          // no openings on missing or transparent (virtual) walls
          if (!s.plan.walls[wallId] || s.plan.walls[wallId].transparent) return
          s.plan.openings[id] = {
            id,
            wallId,
            type,
            style: style ?? (type === 'window' ? 'sliding' : undefined),
            position,
            width,
          }
        })
        return id
      },

      moveOpening: (id, position) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (o) o.position = position
        }),

      toggleOpeningFlip: (id, axis) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (!o) return
          if (axis === 'h') o.flipH = !o.flipH
          else o.flipV = !o.flipV
        }),

      setOpeningFlips: (id, flipH, flipV) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (o) {
            o.flipH = flipH
            o.flipV = flipV
          }
        }),

      setOpeningWidth: (id, width) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (!o) return
          const w = s.plan.walls[o.wallId]
          if (!w) return
          const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
          const ww = Math.min(width, len)
          o.width = ww
          o.position = Math.max(ww / 2, Math.min(len - ww / 2, o.position))
        }),

      resizeOpening: (id, width, position) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (o) {
            o.width = width
            o.position = position
          }
        }),

      setOpeningStyle: (id, style) =>
        set((s) => {
          const o = s.plan.openings[id]
          if (o) o.style = style
        }),

      removeOpening: (id) =>
        set((s) => {
          delete s.plan.openings[id]
          if (s.selectedOpening === id) s.selectedOpening = null
        }),

      deleteWalls: (ids) =>
        set((s) => {
          for (const id of ids) {
            delete s.plan.walls[id]
            for (const o of Object.values(s.plan.openings)) {
              if (o.wallId === id) delete s.plan.openings[o.id]
            }
          }
          s.selection = s.selection.filter((x) => !ids.includes(x))
          if (s.wallProbe && ids.includes(s.wallProbe.wallId))
            s.wallProbe = null
        }),

      setRoomKind: (polygon, anchor, kind, name) =>
        set((s) => {
          if (!s.plan.rooms) s.plan.rooms = {} // pre-rooms plan in session cache
          let excludeArea = false
          for (const r of Object.values(s.plan.rooms)) {
            if (pointInPolygon(r.point, polygon)) {
              excludeArea ||= !!r.excludeArea // keep the flag across kind changes
              delete s.plan.rooms[r.id]
            }
          }
          const id = uid()
          s.plan.rooms[id] = {
            id,
            point: anchor,
            kind,
            ...(name ? { name } : {}),
            ...(excludeArea ? { excludeArea: true } : {}),
          }
        }),

      toggleRoomExcludeArea: (polygon, anchor) =>
        set((s) => {
          if (!s.plan.rooms) s.plan.rooms = {}
          const existing = Object.values(s.plan.rooms).find((r) =>
            pointInPolygon(r.point, polygon),
          )
          if (existing) {
            if (existing.excludeArea) delete existing.excludeArea
            else existing.excludeArea = true
            return
          }
          // no label yet: create a kind-less one that only carries the flag
          const id = uid()
          s.plan.rooms[id] = { id, point: anchor, kind: null, excludeArea: true }
        }),

      duplicateObject: (id) => {
        let nid: string | null = null
        set((s) => {
          const w = s.plan.walls[id]
          if (w) {
            nid = uid()
            s.plan.walls[nid] = { ...w, id: nid, a: { ...w.a }, b: { ...w.b } }
            for (const o of Object.values(s.plan.openings)) {
              if (o.wallId !== id) continue
              const oid = uid()
              s.plan.openings[oid] = { ...o, id: oid, wallId: nid }
            }
            return
          }
          const o = s.plan.openings[id]
          if (o) {
            nid = uid()
            s.plan.openings[nid] = { ...o, id: nid }
            return
          }
          const f = s.plan.furniture?.[id]
          if (f) {
            nid = uid()
            s.plan.furniture[nid] = { ...f, id: nid, center: { ...f.center } }
          }
        })
        return nid
      },

      // delete a mixed set of walls, openings and furniture in one undo step
      deleteObjects: (ids) =>
        set((s) => {
          const wallIds = ids.filter((id) => s.plan.walls[id])
          for (const id of wallIds) delete s.plan.walls[id]
          for (const o of Object.values(s.plan.openings)) {
            if (ids.includes(o.id) || wallIds.includes(o.wallId))
              delete s.plan.openings[o.id]
          }
          for (const id of ids) {
            if (s.plan.furniture?.[id]) delete s.plan.furniture[id]
          }
          s.selection = []
          s.selectedOpening = null
          s.wallProbe = null
        }),

      addFurniture: (kind, center, width, depth, rotation) => {
        const id = uid()
        set((s) => {
          if (!s.plan.furniture) s.plan.furniture = {} // pre-furniture plan
          s.plan.furniture[id] = {
            id,
            kind,
            center: { ...center },
            width,
            depth,
            rotation,
          }
        })
        return id
      },

      moveFurniture: (id, center, rotation) =>
        set((s) => {
          const f = s.plan.furniture?.[id]
          if (!f) return
          f.center = { ...center }
          if (rotation !== undefined) f.rotation = rotation
        }),

      resizeFurniture: (id, width, depth) =>
        set((s) => {
          const f = s.plan.furniture?.[id]
          if (!f) return
          f.width = width
          f.depth = depth
        }),

      rotateFurniture: (id, delta) =>
        set((s) => {
          const f = s.plan.furniture?.[id]
          if (!f) return
          f.rotation = (f.rotation + delta) % 360
        }),

      flipFurniture: (id, axis) =>
        set((s) => {
          const f = s.plan.furniture?.[id]
          if (!f) return
          if (axis === 'h') f.flipH = !f.flipH
          else f.flipV = !f.flipV
        }),

      rotateFurnitureGroup: (ids, dir, pivot) =>
        set((s) => {
          for (const id of ids) {
            const f = s.plan.furniture?.[id]
            if (!f) continue
            const dx = f.center.x - pivot.x
            const dy = f.center.y - pivot.y
            f.center =
              dir === 1
                ? { x: pivot.x - dy, y: pivot.y + dx } // 90° CW (screen)
                : { x: pivot.x + dy, y: pivot.y - dx }
            f.rotation = (f.rotation + dir * 90) % 360
          }
        }),

      alignFurniture: (ids, mode) =>
        set((s) => {
          const boxes = ids
            .map((id) => s.plan.furniture?.[id])
            .filter((f): f is NonNullable<typeof f> => !!f)
            .map((f) => {
              const cs = furnitureCorners(f)
              const xs = cs.map((c) => c.x)
              const ys = cs.map((c) => c.y)
              return {
                f,
                minX: Math.min(...xs),
                maxX: Math.max(...xs),
                minY: Math.min(...ys),
                maxY: Math.max(...ys),
              }
            })
          if (boxes.length < 2) return
          const minX = Math.min(...boxes.map((b) => b.minX))
          const maxX = Math.max(...boxes.map((b) => b.maxX))
          const minY = Math.min(...boxes.map((b) => b.minY))
          const maxY = Math.max(...boxes.map((b) => b.maxY))
          for (const b of boxes) {
            if (mode === 'left') b.f.center.x += minX - b.minX
            else if (mode === 'right') b.f.center.x += maxX - b.maxX
            else if (mode === 'centerX')
              b.f.center.x += (minX + maxX) / 2 - (b.minX + b.maxX) / 2
            else if (mode === 'top') b.f.center.y += minY - b.minY
            else if (mode === 'bottom') b.f.center.y += maxY - b.maxY
            else b.f.center.y += (minY + maxY) / 2 - (b.minY + b.maxY) / 2
          }
        }),

      flipFurnitureGroup: (ids, axis, pivot) =>
        set((s) => {
          for (const id of ids) {
            const f = s.plan.furniture?.[id]
            if (!f) continue
            // mirroring negates the rotation and toggles the matching flip
            if (axis === 'h') {
              f.center = { x: 2 * pivot.x - f.center.x, y: f.center.y }
              f.flipH = !f.flipH
            } else {
              f.center = { x: f.center.x, y: 2 * pivot.y - f.center.y }
              f.flipV = !f.flipV
            }
            f.rotation = -f.rotation
          }
        }),

      bringFurnitureToFront: (id) =>
        set((s) => {
          const f = s.plan.furniture?.[id]
          if (!f) return
          // insertion order is the stacking order: re-insert last
          delete s.plan.furniture[id]
          s.plan.furniture[id] = f
        }),

      clear: () =>
        set((s) => {
          s.plan = emptyPlan()
          s.selection = []
          s.selectedOpening = null
          s.wallProbe = null
          s.roomPick = null
        }),

      loadPlan: (plan) =>
        set((s) => {
          if (!plan.rooms) plan.rooms = {} // legacy/imported data
          if (!plan.furniture) plan.furniture = {}
          // normalise kind/thickness consistency (legacy/imported data)
          for (const w of Object.values(plan.walls)) {
            w.kind = w.thickness >= 250 ? 'exterior' : 'interior'
            w.thickness = WALL_THICKNESS[w.kind]
          }
          // sanitise: drop degenerate walls (zero length / bad numbers) and
          // openings that lost their wall or fell outside it
          for (const w of Object.values(plan.walls)) {
            const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
            if (!isFinite(len) || len < 1) delete plan.walls[w.id]
          }
          for (const o of Object.values(plan.openings)) {
            const w = plan.walls[o.wallId]
            if (!w || !isFinite(o.position) || !isFinite(o.width)) {
              delete plan.openings[o.id]
              continue
            }
            const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
            o.width = Math.max(1, Math.min(o.width, len))
            o.position = Math.max(
              o.width / 2,
              Math.min(len - o.width / 2, o.position),
            )
          }
          for (const f of Object.values(plan.furniture)) {
            if (
              !isFinite(f.center?.x) ||
              !isFinite(f.center?.y) ||
              !isFinite(f.width) ||
              !isFinite(f.depth) ||
              !isFinite(f.rotation)
            ) {
              delete plan.furniture[f.id]
            }
          }
          s.plan = plan
          s.tool = 'select'
          s.selection = []
          s.selectedOpening = null
          s.wallProbe = null
          s.roomPick = null
        }),

      restorePlan: (plan) =>
        set((s) => {
          s.plan = plan
        }),
    })),
    {
      partialize: (state) => ({ plan: state.plan }),
      limit: 100,
      equality: (a, b) => a.plan === b.plan,
    },
  ),
)

export const useTemporal = usePlanStore.temporal
