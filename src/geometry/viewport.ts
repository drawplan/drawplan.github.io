import type { Point } from '../types/model'

/** Maps the world (mm) onto the screen (px).
 *  scale = pixels per mm. offset = screen px of world origin. */
export interface Viewport {
  scale: number
  offsetX: number
  offsetY: number
}

export const initialViewport = (): Viewport => ({
  // 0.05 px/mm => a 10 m wall (10000 mm) renders as 500 px.
  scale: 0.05,
  offsetX: 80,
  offsetY: 80,
})

export const worldToScreen = (p: Point, vp: Viewport): Point => ({
  x: p.x * vp.scale + vp.offsetX,
  y: p.y * vp.scale + vp.offsetY,
})

export const screenToWorld = (p: Point, vp: Viewport): Point => ({
  x: (p.x - vp.offsetX) / vp.scale,
  y: (p.y - vp.offsetY) / vp.scale,
})

/** Zoom while keeping the world point under the cursor stationary. */
export const zoomAt = (vp: Viewport, screen: Point, factor: number): Viewport => {
  const scale = clamp(vp.scale * factor, 0.005, 2)
  const k = scale / vp.scale
  return {
    scale,
    offsetX: screen.x - (screen.x - vp.offsetX) * k,
    offsetY: screen.y - (screen.y - vp.offsetY) * k,
  }
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))
