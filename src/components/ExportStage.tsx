import { Layer, Line, Rect, Stage, Text } from 'react-konva'
import type Konva from 'konva'
import { usePlanStore } from '../store/usePlanStore'
import PlanLayer, {
  DimensionLayer,
  OpeningRegions,
  RoomAnnotations,
  RoomFills,
} from './PlanLayer'
import FurnitureLayer from './FurnitureLayer'
import { furnitureBBox, type BBox } from '../geometry/furniture'
import type { Viewport } from '../geometry/viewport'
import type { FloorPlan } from '../types/model'

/** Height of the caption strip (plan name + dates) below the drawing. */
export const FOOTER_PX = 48

/** World bbox of everything drawn: walls (incl. thickness) + furniture. */
function contentBBox(plan: FloorPlan): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of Object.values(plan.walls)) {
    const half = w.thickness / 2
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x - half)
      minY = Math.min(minY, p.y - half)
      maxX = Math.max(maxX, p.x + half)
      maxY = Math.max(maxY, p.y + half)
    }
  }
  const fb = furnitureBBox(Object.values(plan.furniture ?? {}))
  if (fb) {
    minX = Math.min(minX, fb.minX)
    minY = Math.min(minY, fb.minY)
    maxX = Math.max(maxX, fb.maxX)
    maxY = Math.max(maxY, fb.maxY)
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** Margin around the content: room for door swings, and for the auto
 *  dimension chains (2.3 m outside the walls) when they are visible. */
const marginMM = (showDims: boolean) => (showDims ? 3100 : 1200)

/** World size (mm) the export drawing area must cover — used by the export
 *  functions to pick a stage size with the right aspect ratio. */
export function exportWorldSize(
  plan: FloorPlan,
  showDims: boolean,
): { w: number; h: number } {
  const b = contentBBox(plan) ?? { minX: 0, minY: 0, maxX: 10000, maxY: 7000 }
  const m = marginMM(showDims)
  return { w: b.maxX - b.minX + 2 * m, h: b.maxY - b.minY + 2 * m }
}

export interface ExportFooter {
  name: string
  modified: string // formatted last-modified time
  printed: string // formatted export time
}

const noop = () => {}

/** Clean print rendering of the current plan (no grid, no selection overlays)
 *  with a caption strip at the bottom. Mounted offscreen by the exporters. */
export default function ExportStage({
  width,
  height,
  footer,
  onStage,
}: {
  width: number
  height: number
  footer: ExportFooter
  onStage: (stage: Konva.Stage | null) => void
}) {
  const plan = usePlanStore((s) => s.plan)
  const showDims = usePlanStore((s) => s.showDims)

  const bbox = contentBBox(plan) ?? { minX: 0, minY: 0, maxX: 10000, maxY: 7000 }
  const m = marginMM(showDims)
  const drawH = height - FOOTER_PX
  const worldW = bbox.maxX - bbox.minX + 2 * m
  const worldH = bbox.maxY - bbox.minY + 2 * m
  const scale = Math.min(width / worldW, drawH / worldH)
  const viewport: Viewport = {
    scale,
    offsetX: (width - (bbox.minX + bbox.maxX) * scale) / 2,
    offsetY: (drawH - (bbox.minY + bbox.maxY) * scale) / 2,
  }

  return (
    <Stage ref={onStage} width={width} height={height}>
      <Layer listening={false}>
        <Rect x={0} y={0} width={width} height={height} fill="#ffffff" />
        <RoomFills viewport={viewport} />
        <OpeningRegions viewport={viewport} />
        <PlanLayer viewport={viewport} onEndpointDrag={noop} />
        <FurnitureLayer viewport={viewport} />
        <RoomAnnotations viewport={viewport} />
        <DimensionLayer
          viewport={viewport}
          onEditDimension={noop}
          onEditOpeningDim={noop}
        />
        {/* caption strip */}
        <Line
          points={[12, drawH + 6, width - 12, drawH + 6]}
          stroke="#d3d7de"
          strokeWidth={1}
        />
        <Text
          x={12}
          y={drawH + 16}
          text={footer.name}
          fontSize={14}
          fontStyle="bold"
          fill="#384154"
        />
        <Text
          x={width - 332}
          y={drawH + 11}
          width={320}
          align="right"
          text={`마지막 수정일: ${footer.modified}`}
          fontSize={11}
          fill="#6a7280"
        />
        <Text
          x={width - 332}
          y={drawH + 27}
          width={320}
          align="right"
          text={`출력일: ${footer.printed}`}
          fontSize={11}
          fill="#6a7280"
        />
      </Layer>
    </Stage>
  )
}
