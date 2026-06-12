import { Line } from 'react-konva'
import { screenToWorld, type Viewport } from '../geometry/viewport'

const MINOR_MM = 1000 // 1 m
const MAJOR_MM = 5000 // 5 m

interface Props {
  viewport: Viewport
  width: number
  height: number
}

/** Adaptive metric grid covering the visible viewport. */
export default function Grid({ viewport, width, height }: Props) {
  const tl = screenToWorld({ x: 0, y: 0 }, viewport)
  const br = screenToWorld({ x: width, y: height }, viewport)

  const lines: { points: number[]; major: boolean }[] = []

  const startX = Math.floor(tl.x / MINOR_MM) * MINOR_MM
  const endX = Math.ceil(br.x / MINOR_MM) * MINOR_MM
  for (let x = startX; x <= endX; x += MINOR_MM) {
    const sx = x * viewport.scale + viewport.offsetX
    lines.push({ points: [sx, 0, sx, height], major: x % MAJOR_MM === 0 })
  }

  const startY = Math.floor(tl.y / MINOR_MM) * MINOR_MM
  const endY = Math.ceil(br.y / MINOR_MM) * MINOR_MM
  for (let y = startY; y <= endY; y += MINOR_MM) {
    const sy = y * viewport.scale + viewport.offsetY
    lines.push({ points: [0, sy, width, sy], major: y % MAJOR_MM === 0 })
  }

  return (
    <>
      {lines.map((l, i) => (
        <Line
          key={i}
          points={l.points}
          stroke={l.major ? '#c6cad3' : '#dde0e7'}
          strokeWidth={1}
          listening={false}
        />
      ))}
    </>
  )
}
