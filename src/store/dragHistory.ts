import { usePlanStore } from './usePlanStore'
import type { FloorPlan } from '../types/model'

// Coalesces a drag gesture (many intermediate mutations) into ONE undo step.
// During the drag, temporal tracking is paused so intermediate states aren't
// recorded; on end we re-apply the final plan as a single tracked change whose
// "previous" is the pre-drag baseline.

let baseline: FloorPlan | null = null

export function beginDrag() {
  baseline = structuredClone(usePlanStore.getState().plan)
  usePlanStore.temporal.getState().pause()
}

export function endDrag() {
  if (!baseline) return
  const temporal = usePlanStore.temporal.getState()
  const store = usePlanStore.getState()
  const finalPlan = structuredClone(store.plan)
  store.restorePlan(baseline) // back to baseline while still paused (untracked)
  temporal.resume()
  store.restorePlan(finalPlan) // baseline -> final, recorded as one entry
  baseline = null
}

export function cancelDrag() {
  if (!baseline) return
  usePlanStore.getState().restorePlan(baseline)
  usePlanStore.temporal.getState().resume()
  baseline = null
}
