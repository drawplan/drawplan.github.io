import type { FloorPlan } from '../types/model'

export interface ProjectMeta {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

const INDEX_KEY = 'drawplan.index'
const planKey = (id: string) => `drawplan.plan.${id}`
const draftKey = (id: string) => `drawplan.draft.${id}`
const draftAtKey = (id: string) => `drawplan.draftAt.${id}`
const viewKey = (id: string) => `drawplan.view.${id}`

function readIndex(): ProjectMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    return raw ? (JSON.parse(raw) as ProjectMeta[]) : []
  } catch {
    return []
  }
}

function writeIndex(list: ProjectMeta[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list))
}

export function listProjects(): ProjectMeta[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProjectMeta(id: string): ProjectMeta | null {
  return readIndex().find((m) => m.id === id) ?? null
}

export function createProject(name: string, description: string): ProjectMeta {
  const now = Date.now()
  const meta: ProjectMeta = {
    id: crypto.randomUUID(),
    name: name.trim() || '이름 없음',
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
  }
  writeIndex([...readIndex(), meta])
  return meta
}

export function updateProjectMeta(
  id: string,
  name: string,
  description: string,
): ProjectMeta | null {
  let updated: ProjectMeta | null = null
  writeIndex(
    readIndex().map((m) => {
      if (m.id !== id) return m
      updated = { ...m, name: name.trim() || m.name, description: description.trim() }
      return updated
    }),
  )
  return updated
}

export function savePlanData(id: string, plan: FloorPlan) {
  localStorage.setItem(planKey(id), JSON.stringify(plan))
  writeIndex(
    readIndex().map((m) => (m.id === id ? { ...m, updatedAt: Date.now() } : m)),
  )
}

export function loadPlanData(id: string): FloorPlan | null {
  try {
    const raw = localStorage.getItem(planKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as FloorPlan
    if (!parsed.walls) return null
    return {
      walls: parsed.walls,
      openings: parsed.openings ?? {},
      rooms: parsed.rooms ?? {},
      furniture: parsed.furniture ?? {},
    }
  } catch {
    return null
  }
}

export function deleteProject(id: string) {
  localStorage.removeItem(planKey(id))
  localStorage.removeItem(draftKey(id))
  localStorage.removeItem(draftAtKey(id))
  localStorage.removeItem(viewKey(id))
  writeIndex(readIndex().filter((m) => m.id !== id))
}

/* ---- last viewport (zoom + scroll) per plan ---- */

export interface ViewportData {
  scale: number
  offsetX: number
  offsetY: number
}

export function saveViewport(id: string, vp: ViewportData) {
  localStorage.setItem(viewKey(id), JSON.stringify(vp))
}

export function loadViewport(id: string): ViewportData | null {
  try {
    const raw = localStorage.getItem(viewKey(id))
    if (!raw) return null
    const v = JSON.parse(raw) as ViewportData
    if (!isFinite(v.scale) || v.scale <= 0) return null
    if (!isFinite(v.offsetX) || !isFinite(v.offsetY)) return null
    return { scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY }
  } catch {
    return null
  }
}

/* ---- auto-save drafts (unsaved changes, recovered on next open) ---- */

export function saveDraft(id: string, plan: FloorPlan, editedAt?: number) {
  localStorage.setItem(draftKey(id), JSON.stringify(plan))
  localStorage.setItem(draftAtKey(id), String(editedAt ?? Date.now()))
}

/** Time of the last edit captured in the draft slot, if any. */
export function loadDraftAt(id: string): number | null {
  const raw = localStorage.getItem(draftAtKey(id))
  const n = raw == null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : null
}

export function loadDraft(id: string): FloorPlan | null {
  try {
    const raw = localStorage.getItem(draftKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as FloorPlan
    if (!parsed.walls) return null
    return {
      walls: parsed.walls,
      openings: parsed.openings ?? {},
      rooms: parsed.rooms ?? {},
      furniture: parsed.furniture ?? {},
    }
  } catch {
    return null
  }
}

export function deleteDraft(id: string) {
  localStorage.removeItem(draftKey(id))
  localStorage.removeItem(draftAtKey(id))
}
