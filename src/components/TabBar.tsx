import { useState } from 'react'
import { useTabsStore } from '../store/useTabsStore'
import type { ProjectMeta } from '../storage/projects'

export default function TabBar() {
  const tabs = useTabsStore((s) => s.tabs)
  const active = useTabsStore((s) => s.active)
  const activate = useTabsStore((s) => s.activate)
  const closeTab = useTabsStore((s) => s.closeTab)
  const saveProject = useTabsStore((s) => s.saveProject)
  const [closing, setClosing] = useState<ProjectMeta | null>(null)

  const requestClose = (t: ProjectMeta) => {
    if (useTabsStore.getState().isDirty(t.id)) setClosing(t)
    else closeTab(t.id)
  }

  return (
    <div className="tabbar">
      <span className="brand">🏠 DrawPlan</span>
      <div
        className={`tab ${active === 'main' ? 'active' : ''}`}
        onClick={() => activate('main')}
      >
        ⊞ 내 도면
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => activate(t.id)}
          title={t.description || t.name}
        >
          <span className="tab-name">{t.name}</span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              requestClose(t)
            }}
          >
            ×
          </span>
        </div>
      ))}

      {closing && (
        <div className="dialog-backdrop" onMouseDown={() => setClosing(null)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h3>저장되지 않은 변경</h3>
            <p className="dialog-msg">
              "{closing.name}" 도면에 저장되지 않은 변경이 있습니다.
              <br />
              저장할까요?
            </p>
            <div className="dialog-actions">
              <button className="tool" onClick={() => setClosing(null)}>
                취소
              </button>
              <button
                className="tool"
                onClick={() => {
                  closeTab(closing.id)
                  setClosing(null)
                }}
              >
                저장 안 함
              </button>
              <button
                className="tool primary"
                onClick={() => {
                  saveProject(closing.id)
                  closeTab(closing.id)
                  setClosing(null)
                }}
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
