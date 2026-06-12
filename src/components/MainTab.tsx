import { useMemo, useRef, useState } from 'react'
import type { FloorPlan } from '../types/model'
import {
  createProject,
  deleteProject,
  listProjects,
  loadDraftAt,
  loadPlanData,
  savePlanData,
  updateProjectMeta,
  type ProjectMeta,
} from '../storage/projects'
import { useTabsStore } from '../store/useTabsStore'
import { formatArea, totalArea } from '../geometry/rooms'
import PlanPreview from './PlanPreview'
import { EXAMPLE_PLANS, type ExamplePlan } from '../examples'

function fmtDate(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const PYEONG_MM2 = 3.305785 * 1_000_000

// module-level: once dismissed, stays closed until the page is reloaded
let warnDismissed = false

const ICON_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function DownloadIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden {...ICON_STROKE}>
      <path d="M8 2.5 V10 M4.5 6.8 L8 10.3 L11.5 6.8" />
      <path d="M2.5 11 V13.5 H13.5 V11" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden {...ICON_STROKE}>
      <path d="M3 13 L3.4 10.4 L10.8 3 Q11.5 2.3 12.4 3.2 L12.8 3.6 Q13.7 4.5 13 5.2 L5.6 12.6 Z" />
      <path d="M9.8 4 L12 6.2" />
    </svg>
  )
}

function CopyIcon() {
  // two overlapping pages, like the standard copy icon
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden {...ICON_STROKE}>
      <rect x={5.8} y={5.8} width={8} height={8.2} rx={1.2} />
      <path d="M3.9 10.4 H3.3 Q2 10.4 2 9.1 V3.3 Q2 2 3.3 2 H9.1 Q10.4 2 10.4 3.3 V3.9" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden {...ICON_STROKE}>
      <path d="M3 4.3 H13" />
      <path d="M6.2 4.3 V3.2 Q6.2 2.3 7.1 2.3 H8.9 Q9.8 2.3 9.8 3.2 V4.3" />
      <path d="M4.4 4.3 L5 12.6 Q5.1 13.6 6 13.6 H10 Q10.9 13.6 11 12.6 L11.6 4.3" />
      <path d="M6.7 6.7 V11.2 M9.3 6.7 V11.2" />
    </svg>
  )
}

const fmtTileArea = (plan: FloorPlan | null) => {
  if (!plan) return null
  const total = totalArea(plan)
  if (total <= 0) return null
  return `${formatArea(total)} (${(total / PYEONG_MM2).toFixed(1)} py)`
}

export default function MainTab() {
  const openProject = useTabsStore((s) => s.openProject)
  const closeTab = useTabsStore((s) => s.closeTab)
  const [projects, setProjects] = useState(() => listProjects())
  const plans = useMemo(
    () => new Map(projects.map((m) => [m.id, loadPlanData(m.id)])),
    [projects],
  )
  const [dialog, setDialog] = useState(false)
  const [warnOpen, setWarnOpen] = useState(!warnDismissed)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  // tile being renamed via the pencil button
  const [editing, setEditing] = useState<ProjectMeta | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [examplesOpen, setExamplesOpen] = useState(false)

  /** First "name", "name (1)", "name (2)" … not taken by an existing plan. */
  const uniqueName = (base: string) => {
    const taken = new Set(listProjects().map((p) => p.name))
    let name = base
    for (let i = 1; taken.has(name); i++) name = `${base} (${i})`
    return name
  }

  const copyExample = (s: ExamplePlan) => {
    const meta = createProject(uniqueName(s.name), s.description)
    savePlanData(meta.id, structuredClone(s.plan))
    setProjects(listProjects())
    setExamplesOpen(false)
  }
  const fileRef = useRef<HTMLInputElement>(null)

  const confirmNew = () => {
    if (!name.trim()) return
    const meta = createProject(name, desc)
    setDialog(false)
    setName('')
    setDesc('')
    openProject(meta)
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then((txt) => {
      try {
        const parsed = JSON.parse(txt) as FloorPlan & {
          meta?: { name?: string; description?: string }
        }
        if (!parsed.walls) throw new Error()
        const baseName = parsed.meta?.name || file.name.replace(/\.json$/i, '')
        // duplicate names get a " (n)" suffix so the tiles stay tellable
        const name = uniqueName(baseName)
        const meta = createProject(name, parsed.meta?.description ?? '')
        savePlanData(meta.id, {
          walls: parsed.walls,
          openings: parsed.openings ?? {},
          rooms: parsed.rooms ?? {},
          furniture: parsed.furniture ?? {},
        })
        if (name !== baseName)
          alert(`같은 이름의 도면이 있어 "${name}"(으)로 불러왔습니다.`)
        openProject(meta)
      } catch {
        alert('잘못된 평면도 파일입니다.')
      }
    })
    e.target.value = ''
  }

  const copyPlan = (m: ProjectMeta) => {
    const plan = loadPlanData(m.id)
    if (!plan) {
      alert('저장된 도면 데이터가 없습니다.')
      return
    }
    const meta = createProject(uniqueName(m.name), m.description)
    savePlanData(meta.id, plan)
    setProjects(listProjects())
    openEdit(meta) // name the copy right away
  }

  const openEdit = (m: ProjectMeta) => {
    setEditing(m)
    setEditName(m.name)
    setEditDesc(m.description)
  }

  const confirmEdit = () => {
    if (!editing || !editName.trim()) return
    const updated = updateProjectMeta(editing.id, editName, editDesc)
    if (updated) useTabsStore.getState().updateTabMeta(updated)
    setProjects(listProjects())
    setEditing(null)
  }

  const remove = (id: string, projName: string) => {
    if (!confirm(`"${projName}" 도면을 삭제할까요?`)) return
    deleteProject(id)
    closeTab(id)
    setProjects(listProjects())
  }

  // localStorage dump with an export meta header — falls back to the raw
  // text when the stored data fails to parse (rescue path)
  const exportRaw = (m: ProjectMeta) => {
    const dump = (key: string, file: string, modifiedAt: number) => {
      const raw = localStorage.getItem(key)
      if (raw == null) return false
      let text = raw
      try {
        const plan = JSON.parse(raw) as FloorPlan
        if (!plan.walls) throw new Error()
        text = JSON.stringify(
          {
            meta: {
              app: 'drawplan',
              name: m.name,
              description: m.description,
              modifiedAt: new Date(modifiedAt).toISOString(),
              exportedAt: new Date().toISOString(),
            },
            ...plan,
          },
          null,
          2,
        )
      } catch {
        /* corrupted: export as-is */
      }
      const url = URL.createObjectURL(
        new Blob([text], { type: 'application/json' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = file
      a.click()
      URL.revokeObjectURL(url)
      return true
    }
    const saved = dump(`drawplan.plan.${m.id}`, `${m.name}.json`, m.updatedAt)
    const draft = dump(
      `drawplan.draft.${m.id}`,
      `${m.name}.draft.json`,
      loadDraftAt(m.id) ?? m.updatedAt,
    )
    if (!saved && !draft) alert('저장된 데이터가 없습니다.')
  }

  return (
    <div className="main-tab">
      <div className="main-head">
        <h2>내 도면</h2>
        <div className="group">
          <button className="tool primary" onClick={() => setDialog(true)}>
            ＋ 새 도면
          </button>
          <button className="tool" onClick={() => fileRef.current?.click()}>
            불러오기
          </button>
          <button className="tool" onClick={() => setExamplesOpen(true)}>
            예제 보기
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={onFile}
          />
        </div>
      </div>

      {warnOpen && (
        <p className="main-warn">
          <span>
            ⚠️ 도면은 이 브라우저의 로컬 저장소에 저장됩니다. 브라우저
            기록(사이트 데이터)을 삭제하면 도면이 모두 사라지니, 중요한 도면은
            타일의{' '}
            <span className="warn-icon">
              <DownloadIcon />
            </span>{' '}
            버튼으로 JSON 파일로 내려받아 보관하세요.
          </span>
          <button
            className="warn-close"
            title="닫기"
            onClick={() => {
              warnDismissed = true
              setWarnOpen(false)
            }}
          >
            ×
          </button>
        </p>
      )}

      {projects.length === 0 ? (
        <p className="main-empty">
          저장된 도면이 없습니다. [새 도면]으로 시작하거나 JSON 파일을
          불러오세요.
        </p>
      ) : (
        <div className="proj-grid">
          {projects.map((m) => {
            const plan = plans.get(m.id) ?? null
            const area = fmtTileArea(plan)
            return (
            <div
              key={m.id}
              className="proj-card"
              onClick={() => openProject(m)}
            >
              <PlanPreview plan={plan} />
              <div className="proj-info">
                <div className="proj-name">{m.name}</div>
                {m.description && (
                  <div className="proj-desc">{m.description}</div>
                )}
                <div className="proj-meta">
                  {area && <span className="proj-area">{area}</span>}
                  <span className="proj-date">{fmtDate(m.updatedAt)}</span>
                </div>
              </div>
              <button
                className="proj-del"
                title="삭제"
                onClick={(e) => {
                  e.stopPropagation()
                  remove(m.id, m.name)
                }}
              >
                <TrashIcon />
              </button>
              <button
                className="proj-del proj-export"
                title="JSON으로 저장 (자동 저장 초안 포함)"
                onClick={(e) => {
                  e.stopPropagation()
                  exportRaw(m)
                }}
              >
                <DownloadIcon />
              </button>
              <button
                className="proj-del proj-copy"
                title="도면 복사"
                onClick={(e) => {
                  e.stopPropagation()
                  copyPlan(m)
                }}
              >
                <CopyIcon />
              </button>
              <button
                className="proj-del proj-edit"
                title="이름/설명 수정"
                onClick={(e) => {
                  e.stopPropagation()
                  openEdit(m)
                }}
              >
                <PencilIcon />
              </button>
            </div>
            )
          })}
        </div>
      )}

      {examplesOpen && (
        <div
          className="dialog-backdrop"
          onMouseDown={() => setExamplesOpen(false)}
        >
          <div
            className="dialog dialog-examples"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3>예제 도면</h3>
            <p className="dialog-msg">
              복사하면 내 도면 목록에 추가되어 자유롭게 편집할 수 있습니다.
            </p>
            <div className="example-grid">
              {EXAMPLE_PLANS.map((s) => (
                <div key={s.name} className="proj-card example-card">
                  <PlanPreview plan={s.plan} />
                  <div className="proj-info">
                    <div className="proj-name">{s.name}</div>
                    <div className="proj-desc">{s.description}</div>
                    <button
                      className="tool primary example-copy"
                      onClick={() => copyExample(s)}
                    >
                      복사
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="dialog-actions">
              <button className="tool" onClick={() => setExamplesOpen(false)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="dialog-backdrop" onMouseDown={() => setEditing(null)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h3>도면 정보 수정</h3>
            <label>
              이름
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            </label>
            <label>
              설명
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                placeholder="선택 사항"
              />
            </label>
            <div className="dialog-actions">
              <button className="tool" onClick={() => setEditing(null)}>
                취소
              </button>
              <button
                className="tool primary"
                disabled={!editName.trim()}
                onClick={confirmEdit}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog && (
        <div className="dialog-backdrop" onMouseDown={() => setDialog(false)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h3>새 도면</h3>
            <label>
              이름
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNew()
                  if (e.key === 'Escape') setDialog(false)
                }}
                placeholder="예: 우리집 1층"
              />
            </label>
            <label>
              설명
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNew()
                  if (e.key === 'Escape') setDialog(false)
                }}
                placeholder="선택 사항"
              />
            </label>
            <div className="dialog-actions">
              <button className="tool" onClick={() => setDialog(false)}>
                취소
              </button>
              <button
                className="tool primary"
                disabled={!name.trim()}
                onClick={confirmNew}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="app-version" title={__APP_VERSION_FULL__}>
        v{__APP_VERSION__}
      </div>
    </div>
  )
}
