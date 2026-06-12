import type { Point } from '../types/model'

/** mm -> human label. Shows metres for anything >= 1 m, else cm/mm. */
export const formatLength = (mm: number): string => {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`
  if (mm >= 10) return `${(mm / 10).toFixed(0)} cm`
  return `${Math.round(mm)} mm`
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})
