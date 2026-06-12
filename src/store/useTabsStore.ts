import { create } from 'zustand'
import type { FloorPlan } from '../types/model'
import { emptyPlan } from '../types/model'
import { usePlanStore } from './usePlanStore'
import {
  deleteDraft,
  getProjectMeta,
  loadDraft,
  loadDraftAt,
  loadPlanData,
  saveDraft,
  savePlanData,
  type ProjectMeta,
} from '../storage/projects'

/** In-memory plan snapshots of open tabs (keeps unsaved edits across tab switches). */
const planCache = new Map<string, FloorPlan>()
/** Serialized plan as of last save/load — used to detect unsaved changes. */
const baseline = new Map<string, string>()
/** Time of the last edit per tab this session (drafts persist it across sessions). */
const editedAt = new Map<string, number>()
/** Set while a tab's plan is being loaded into the editor, so the plan-change
 *  subscription doesn't mistake the load for a user edit. */
let loadingPlan = false

/** Write/clear the draft slot for a tab according to its dirtiness. */
function syncDraft(id: string, plan: FloorPlan) {
  if (JSON.stringify(plan) !== baseline.get(id)) saveDraft(id, plan, editedAt.get(id))
  else deleteDraft(id)
}

function stashActive(active: string) {
  if (active === 'main') return
  clearTimeout(draftTimer)
  const plan = structuredClone(usePlanStore.getState().plan)
  planCache.set(active, plan)
  syncDraft(active, plan)
}

/** Load a tab's plan into the editor. Returns true if an auto-saved
 *  draft (differing from the saved plan) was recovered. */
function loadIntoEditor(id: string): boolean {
  loadingPlan = true
  try {
    const cached = planCache.get(id)
    if (cached) {
      usePlanStore.getState().loadPlan(structuredClone(cached))
      usePlanStore.temporal.getState().clear()
      return false
    }
    const saved = loadPlanData(id) ?? emptyPlan()
    usePlanStore.getState().loadPlan(structuredClone(saved))
    baseline.set(id, JSON.stringify(usePlanStore.getState().plan))
    const draft = loadDraft(id)
    let recovered = false
    if (draft && JSON.stringify(draft) !== baseline.get(id)) {
      usePlanStore.getState().loadPlan(structuredClone(draft))
      recovered = true
    }
    usePlanStore.temporal.getState().clear()
    return recovered
  } finally {
    loadingPlan = false
  }
}

/** Current (possibly unsaved) plan of an open tab. */
function tabPlan(id: string, active: string): FloorPlan | undefined {
  return id === active ? usePlanStore.getState().plan : planCache.get(id)
}

interface TabsState {
  tabs: ProjectMeta[]
  /** 'main' or a project id */
  active: string
  /** Project id whose auto-saved draft was just recovered (shows a banner). */
  recoveredId: string | null
  openProject: (meta: ProjectMeta) => void
  /** Refresh an open tab's name/description after a meta edit. */
  updateTabMeta: (meta: ProjectMeta) => void
  activate: (id: string) => void
  closeTab: (id: string) => void
  /** Persist a tab's plan to localStorage and reset its dirty baseline. */
  saveProject: (id: string) => void
  /** True if the tab's plan differs from the last saved/loaded state. */
  isDirty: (id: string) => boolean
  /** Time of the last modification: the last edit if there are unsaved
   *  changes (recovered drafts included), else the last save. */
  lastModifiedAt: (id: string) => number
  /** Keep the recovered draft as unsaved changes. */
  dismissRecovery: () => void
  /** Throw away the recovered draft and revert to the saved plan. */
  discardRecovery: () => void
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  active: 'main',
  recoveredId: null,

  openProject: (meta) => {
    const { tabs, active } = get()
    if (active === meta.id) return
    stashActive(active)
    if (!tabs.some((t) => t.id === meta.id)) {
      set({ tabs: [...tabs, meta] })
    }
    const recovered = loadIntoEditor(meta.id)
    set({ active: meta.id, ...(recovered ? { recoveredId: meta.id } : {}) })
  },

  updateTabMeta: (meta) =>
    set({
      tabs: get().tabs.map((t) => (t.id === meta.id ? meta : t)),
    }),

  activate: (id) => {
    const { active } = get()
    if (id === active) return
    stashActive(active)
    if (id !== 'main') {
      const recovered = loadIntoEditor(id)
      if (recovered) set({ recoveredId: id })
    }
    set({ active: id })
  },

  closeTab: (id) => {
    const { tabs, active, recoveredId } = get()
    planCache.delete(id)
    baseline.delete(id)
    editedAt.delete(id)
    deleteDraft(id)
    set({ tabs: tabs.filter((t) => t.id !== id) })
    if (active === id) set({ active: 'main' })
    if (recoveredId === id) set({ recoveredId: null })
  },

  saveProject: (id) => {
    const plan = tabPlan(id, get().active)
    if (!plan) return
    savePlanData(id, plan)
    baseline.set(id, JSON.stringify(plan))
    deleteDraft(id)
    if (get().recoveredId === id) set({ recoveredId: null })
  },

  isDirty: (id) => {
    const plan = tabPlan(id, get().active)
    if (!plan) return false
    return JSON.stringify(plan) !== baseline.get(id)
  },

  lastModifiedAt: (id) => {
    if (get().isDirty(id))
      return editedAt.get(id) ?? loadDraftAt(id) ?? Date.now()
    return getProjectMeta(id)?.updatedAt ?? Date.now()
  },

  dismissRecovery: () => set({ recoveredId: null }),

  discardRecovery: () => {
    const id = get().recoveredId
    if (!id) return
    deleteDraft(id)
    const saved = loadPlanData(id) ?? emptyPlan()
    usePlanStore.getState().loadPlan(structuredClone(saved))
    baseline.set(id, JSON.stringify(usePlanStore.getState().plan))
    planCache.delete(id)
    usePlanStore.temporal.getState().clear()
    set({ recoveredId: null })
  },
}))

/* ---- auto-save: debounced draft writes + flush on hide/unload ---- */

let draftTimer: ReturnType<typeof setTimeout> | undefined

function flushDraft() {
  clearTimeout(draftTimer)
  const { active } = useTabsStore.getState()
  if (active === 'main') return
  syncDraft(active, usePlanStore.getState().plan)
}

usePlanStore.subscribe((s, prev) => {
  if (s.plan === prev.plan) return
  const { active } = useTabsStore.getState()
  if (!loadingPlan && active !== 'main') editedAt.set(active, Date.now())
  clearTimeout(draftTimer)
  draftTimer = setTimeout(flushDraft, 2500)
})

window.addEventListener('beforeunload', flushDraft)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushDraft()
})
