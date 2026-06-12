// All world coordinates are stored in millimetres (mm), never pixels.
// The render layer converts mm <-> screen pixels via the Viewport.

export interface Point {
  x: number
  y: number
}

export type WallKind = 'exterior' | 'interior'

/** Default thickness (mm) per wall kind. */
export const WALL_THICKNESS: Record<WallKind, number> = {
  exterior: 300,
  interior: 200,
}

/** A wall is independent: it owns its two endpoints directly. Walls are no
 *  longer joined through shared nodes — endpoints may simply coincide. */
export interface Wall {
  id: string
  a: Point // start endpoint (mm)
  b: Point // end endpoint (mm)
  thickness: number // mm
  kind: WallKind
  /** Virtual wall: dashed outline, ignored by furniture snapping/limits and
   *  by door/window placement, but still bounds rooms. */
  transparent?: boolean
}

/** Toolbar wall presets (the wall tool's dropdown). */
export interface WallPick {
  label: string
  kind: WallKind
  transparent: boolean
}

export const WALL_PICKS: WallPick[] = [
  { label: '외벽', kind: 'exterior', transparent: false },
  { label: '내벽', kind: 'interior', transparent: false },
  { label: '외벽(투명)', kind: 'exterior', transparent: true },
  { label: '내벽(투명)', kind: 'interior', transparent: true },
]

export type WallEnd = 'a' | 'b'

export type OpeningType = 'door' | 'window'

/** Door leaf style. */
export type DoorStyle = 'hinge' | 'pocket' | 'sliding' | 'folding'
/** Window style. */
export type WindowStyle = 'turn' | 'sliding' | 'awning' | 'hung' | 'fix'
export type OpeningStyle = DoorStyle | WindowStyle

/** A door/window variant pickable from the toolbar dropdown. */
export interface OpeningPick {
  type: OpeningType
  style: OpeningStyle
  label: string
  width: number // default width (mm)
}

export const DOOR_PICKS: OpeningPick[] = [
  { type: 'door', style: 'hinge', label: '여닫이', width: 900 },
  { type: 'door', style: 'pocket', label: '미닫이', width: 900 },
  { type: 'door', style: 'sliding', label: '미서기', width: 900 },
  { type: 'door', style: 'folding', label: '접이', width: 900 },
]

export const WINDOW_PICKS: OpeningPick[] = [
  { type: 'window', style: 'sliding', label: '슬라이딩', width: 900 },
  { type: 'window', style: 'turn', label: '여닫이', width: 900 },
  { type: 'window', style: 'awning', label: '어닝', width: 600 },
  { type: 'window', style: 'hung', label: '오르내리', width: 600 },
  { type: 'window', style: 'fix', label: '고정', width: 900 },
]

/** A door or window positioned along a wall (from endpoint a). */
export interface Opening {
  id: string
  wallId: string
  type: OpeningType
  style?: OpeningStyle // door defaults to 'hinge', window to 'sliding'
  position: number // distance (mm) from endpoint a
  width: number // mm
  flipH?: boolean // hinge side along the wall (left/right)
  flipV?: boolean // swing side across the wall (up/down)
}

/** Room kind, assignable via the room context menu. */
export type RoomKind =
  | 'bedroom'
  | 'living'
  | 'study'
  | 'kitchen'
  | 'dining'
  | 'bath'
  | 'utility'
  | 'entrance'
  | 'dress'
  | 'pantry'
  | 'hallway'
  | 'storage'
  | 'boiler'
  | 'etc'

/** Insertion order = display order of the room-kind menu. */
export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  bedroom: '침실',
  living: '거실',
  study: '서재',
  kitchen: '주방',
  dining: '다이닝',
  bath: '화장실',
  utility: '다용도실',
  entrance: '현관',
  dress: '옷방',
  pantry: '팬트리',
  hallway: '복도',
  storage: '창고',
  boiler: '보일러실',
  etc: '기타',
}

/** A room property label, anchored to a point inside the room. The room
 *  containing the point carries the label (robust to wall edits). */
export interface RoomLabel {
  id: string
  point: Point
  kind: RoomKind | null // null: no kind chosen (label only carries flags)
  name?: string // custom name when kind === 'etc'
  excludeArea?: boolean // room not counted in the total area
}

/** Furniture kind — determines the top-view symbol. Appliances (가전) and
 *  sanitary fixtures (도기) share the furniture model and behaviours. */
export type FurnitureKind =
  | 'desk'
  | 'dining'
  | 'chair'
  | 'bed'
  | 'sofa'
  | 'table'
  | 'wardrobe'
  | 'sink'
  | 'cabinet'
  | 'shoe'
  // appliances
  | 'tv'
  | 'fridge'
  | 'washer'
  | 'aircon'
  | 'cooktop'
  | 'hood'
  // sanitary fixtures
  | 'sinkbowl'
  | 'basin'
  | 'basinCounter'
  | 'toilet'
  | 'bathtub'
  | 'shower'
  | 'showerPartition'

export const FURNITURE_KIND_LABELS: Record<FurnitureKind, string> = {
  desk: '책상',
  dining: '식탁',
  chair: '의자',
  bed: '침대',
  sofa: '소파',
  table: '테이블',
  wardrobe: '옷장',
  sink: '싱크대',
  cabinet: '수납장',
  shoe: '신발장',
  tv: 'TV',
  fridge: '냉장고',
  washer: '세탁기',
  aircon: '에어콘',
  cooktop: '쿡탑',
  hood: '후드',
  sinkbowl: '싱크볼',
  basin: '세면대(단독)',
  basinCounter: '세면대(카운터)',
  toilet: '변기',
  bathtub: '욕조',
  shower: '샤워기',
  showerPartition: '샤워 파티션',
}

/** Toolbar presets — bed/sofa variants share a kind, differing only in size
 *  (pillow/cushion counts are derived from the width when rendering). */
export interface FurniturePreset {
  label: string
  kind: FurnitureKind
  width: number
  depth: number
}

export const FURNITURE_PRESETS: FurniturePreset[] = [
  { label: '책상', kind: 'desk', width: 1200, depth: 600 },
  { label: '식탁', kind: 'dining', width: 1400, depth: 800 },
  { label: '의자', kind: 'chair', width: 450, depth: 450 },
  { label: '침대(1인)', kind: 'bed', width: 1100, depth: 2100 },
  { label: '침대(2인)', kind: 'bed', width: 1600, depth: 2100 },
  { label: '소파(1인)', kind: 'sofa', width: 800, depth: 900 },
  { label: '소파(2인)', kind: 'sofa', width: 1600, depth: 900 },
  { label: '소파(3인)', kind: 'sofa', width: 2400, depth: 900 },
  { label: '소파(4인)', kind: 'sofa', width: 3200, depth: 900 },
  { label: '테이블', kind: 'table', width: 800, depth: 400 },
  { label: '옷장', kind: 'wardrobe', width: 1200, depth: 600 },
  { label: '수납장', kind: 'cabinet', width: 600, depth: 600 },
  { label: '신발장', kind: 'shoe', width: 900, depth: 300 },
]

export const APPLIANCE_PRESETS: FurniturePreset[] = [
  { label: 'TV', kind: 'tv', width: 1300, depth: 150 },
  { label: '냉장고', kind: 'fridge', width: 900, depth: 900 },
  { label: '세탁기', kind: 'washer', width: 800, depth: 800 },
  { label: '에어콘', kind: 'aircon', width: 600, depth: 300 },
]

/** 주방/욕실: kitchen counters/hobs and sanitary fixtures. */
export const FIXTURE_PRESETS: FurniturePreset[] = [
  { label: '싱크대', kind: 'sink', width: 1200, depth: 600 },
  { label: '싱크볼', kind: 'sinkbowl', width: 900, depth: 500 },
  { label: '쿡탑(대)', kind: 'cooktop', width: 600, depth: 500 },
  { label: '쿡탑(소)', kind: 'cooktop', width: 400, depth: 500 },
  { label: '후드', kind: 'hood', width: 800, depth: 500 },
  { label: '세면대(단독)', kind: 'basin', width: 500, depth: 400 },
  { label: '세면대(카운터)', kind: 'basinCounter', width: 900, depth: 600 },
  { label: '변기', kind: 'toilet', width: 400, depth: 750 },
  { label: '욕조', kind: 'bathtub', width: 800, depth: 1500 },
  { label: '샤워기', kind: 'shower', width: 100, depth: 200 },
  { label: '샤워 파티션', kind: 'showerPartition', width: 100, depth: 600 },
]

/** A piece of furniture. Local x runs along the width, local y along the
 *  depth; the back edge (the side that snaps to walls) is at local -y. */
export interface Furniture {
  id: string
  kind: FurnitureKind
  center: Point // world mm
  width: number // mm
  depth: number // mm
  rotation: number // degrees, clockwise on screen (y-down)
  flipH?: boolean // mirror along the local width axis
  flipV?: boolean // mirror along the local depth axis
}

/** Normalised, id-keyed model — the single source of truth. */
export interface FloorPlan {
  walls: Record<string, Wall>
  openings: Record<string, Opening>
  rooms: Record<string, RoomLabel>
  furniture: Record<string, Furniture>
}

export const emptyPlan = (): FloorPlan => ({
  walls: {},
  openings: {},
  rooms: {},
  furniture: {},
})
