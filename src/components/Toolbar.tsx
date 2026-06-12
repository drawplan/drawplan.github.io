import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { usePlanStore, type ToolId } from '../store/usePlanStore'
import { useTabsStore } from '../store/useTabsStore'
import { formatArea, totalArea } from '../geometry/rooms'
import {
  APPLIANCE_PRESETS,
  DOOR_PICKS,
  FIXTURE_PRESETS,
  FURNITURE_PRESETS,
  WALL_PICKS,
  WALL_THICKNESS,
  WINDOW_PICKS,
  type FurniturePreset,
} from '../types/model'
import {
  exportPlanJSON,
  exportPlanPDF,
  exportPlanPNG,
} from '../export/exporters'
import { doorScreenGeometry } from '../geometry/door'
import { windowScreenGeometry } from '../geometry/window'
import type { OpeningPick, Wall, WallPick } from '../types/model'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Stage, Layer } from 'react-konva'
import type Konva from 'konva'
import { FurnitureSymbol } from './FurnitureLayer'

/** Identity viewport: geometry functions emit world-mm coordinates. */
const PREVIEW_VP = { scale: 1, offsetX: 0, offsetY: 0 }

/** Dropdown item thumbnail of a wall variant: a bar at relative thickness. */
function WallItemPreview({ pick }: { pick: WallPick }) {
  const th = WALL_THICKNESS[pick.kind]
  return (
    <svg className="dd-prev" width={44} height={18} viewBox="-60 -250 1120 500">
      {pick.transparent ? (
        <rect
          x={0}
          y={-th / 2}
          width={1000}
          height={th}
          fill="none"
          stroke="#2f333b"
          opacity={0.35}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          strokeDasharray="5 4"
        />
      ) : (
        <rect x={0} y={-th / 2} width={1000} height={th} fill="#2f333b" />
      )}
    </svg>
  )
}

/** Dropdown item thumbnail of a door/window style, from the real symbol
 *  geometry on a synthetic horizontal wall. */
function OpeningItemPreview({ pick }: { pick: OpeningPick }) {
  const W = pick.width + 700 // wall shoulders around the opening
  const TH = 220
  const wall: Wall = {
    id: 'preview',
    a: { x: 0, y: 0 },
    b: { x: W, y: 0 },
    thickness: TH,
    kind: 'interior',
  }
  const spec = { position: W / 2, width: pick.width, style: pick.style }
  const g =
    pick.type === 'window'
      ? windowScreenGeometry(wall, spec, PREVIEW_VP)
      : doorScreenGeometry(wall, spec, PREVIEW_VP)
  let minY = -TH / 2
  let maxY = TH / 2
  for (const st of g.strokes) {
    for (let i = 1; i < st.points.length; i += 2) {
      minY = Math.min(minY, st.points[i])
      maxY = Math.max(maxY, st.points[i])
    }
  }
  const pad = 60
  const toPoints = (flat: number[]) => {
    const out: string[] = []
    for (let i = 0; i < flat.length; i += 2)
      out.push(`${flat[i]},${flat[i + 1]}`)
    return out.join(' ')
  }
  return (
    <svg
      className="dd-prev"
      width={44}
      height={26}
      viewBox={`${-pad} ${minY - pad} ${W + pad * 2} ${maxY - minY + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <line x1={0} y1={0} x2={W} y2={0} stroke="#2f333b" strokeWidth={TH} />
      <line
        x1={g.gap[0].x}
        y1={g.gap[0].y}
        x2={g.gap[1].x}
        y2={g.gap[1].y}
        stroke="#ffffff"
        strokeWidth={TH + 2}
        strokeLinecap="butt"
      />
      {g.strokes.map((st, i) => (
        <polyline
          key={i}
          points={toPoints(st.points)}
          fill="none"
          stroke={st.dash ? '#b8bdc8' : '#48597a'}
          strokeWidth={1.1}
          vectorEffect="non-scaling-stroke"
          strokeDasharray={st.dash ? '4 3' : undefined}
        />
      ))}
    </svg>
  )
}


/** Furniture preset thumbnails: each symbol is rendered once into an
 *  offscreen Konva stage and cached as a data URL. */
const furnPrevCache = new Map<string, string>()
const PREV_W = 44
const PREV_H = 26

function renderPresetImage(p: FurniturePreset): string {
  const pad = 2
  const scale = Math.min(
    (PREV_W - pad * 2) / p.width,
    (PREV_H - pad * 2) / p.depth,
  )
  const vp = { scale, offsetX: PREV_W / 2, offsetY: PREV_H / 2 }
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:0'
  document.body.appendChild(host)
  const root = createRoot(host)
  let stage: Konva.Stage | null = null
  try {
    flushSync(() => {
      root.render(
        <Stage
          width={PREV_W}
          height={PREV_H}
          ref={(n) => {
            stage = n
          }}
        >
          <Layer>
            <FurnitureSymbol
              f={{
                kind: p.kind,
                center: { x: 0, y: 0 },
                width: p.width,
                depth: p.depth,
                rotation: 0,
              }}
              viewport={vp}
              stroke="#5a6472"
            />
          </Layer>
        </Stage>,
      )
    })
    if (!stage) return ''
    ;(stage as Konva.Stage).draw()
    return (stage as Konva.Stage).toDataURL({ pixelRatio: 2 })
  } finally {
    root.unmount()
    host.remove()
  }
}

function FurnitureItemPreview({ preset }: { preset: FurniturePreset }) {
  const [url, setUrl] = useState(() => furnPrevCache.get(preset.label) ?? null)
  useEffect(() => {
    if (url) return
    // render outside React's commit phase — flushSync into another root is
    // a no-op while React is already rendering
    const t = setTimeout(() => {
      const u = renderPresetImage(preset)
      if (u) furnPrevCache.set(preset.label, u)
      setUrl(u || null)
    }, 0)
    return () => clearTimeout(t)
  }, [url, preset])
  return url ? (
    <img className="dd-prev" src={url} width={PREV_W} height={PREV_H} alt="" />
  ) : (
    <span className="dd-prev" style={{ width: PREV_W, height: PREV_H }} />
  )
}

/** Close an open dropdown with Esc — captured before the canvas Esc handler
 *  so the keypress doesn't also clear the selection/tool. */
function useDropdownEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])
}

/** Toolbar dropdown of placeable presets (가구/가전/주방·욕실). */
function PresetDropdown({
  title,
  presets,
  active,
  pickedLabel,
  onPick,
}: {
  title: string
  presets: FurniturePreset[]
  active: boolean // furniture tool is on AND the pick belongs to this group
  pickedLabel: string | null
  onPick: (p: FurniturePreset) => void
}) {
  const [open, setOpen] = useState(false)
  useDropdownEscape(open, () => setOpen(false))
  return (
    <div className="dropdown">
      <button
        className={`tool ${active ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {active && pickedLabel ? `${title}: ${pickedLabel} ▾` : `${title} ▾`}
      </button>
      {open && (
        <>
          <div className="dropdown-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="dropdown-menu">
            {presets.map((p) => (
              <button
                key={p.label}
                className={active && pickedLabel === p.label ? 'active' : ''}
                onClick={() => {
                  onPick(p)
                  setOpen(false)
                }}
              >
                <FurnitureItemPreview preset={p} />
                {p.label}
                <span className="dd-size">
                  {p.width}×{p.depth}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function Toolbar() {
  const tool = usePlanStore((s) => s.tool)
  const setTool = usePlanStore((s) => s.setTool)
  const plan = usePlanStore((s) => s.plan)
  const showDims = usePlanStore((s) => s.showDims)
  const toggleDims = usePlanStore((s) => s.toggleDims)
  const debug = usePlanStore((s) => s.debug)
  const toggleDebug = usePlanStore((s) => s.toggleDebug)
  const active = useTabsStore((s) => s.active)
  const project = useTabsStore((s) => s.tabs.find((t) => t.id === s.active))
  const [saved, setSaved] = useState(false)
  const furniturePick = usePlanStore((s) => s.furniturePick)
  const setFurniturePick = usePlanStore((s) => s.setFurniturePick)
  const wallPick = usePlanStore((s) => s.wallPick)
  const setWallPick = usePlanStore((s) => s.setWallPick)
  const [wallOpen, setWallOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const doorPick = usePlanStore((s) => s.doorPick)
  const windowPick = usePlanStore((s) => s.windowPick)
  const setOpeningPick = usePlanStore((s) => s.setOpeningPick)
  const [openingOpen, setOpeningOpen] = useState<ToolId | null>(null)
  useDropdownEscape(wallOpen, () => setWallOpen(false))
  useDropdownEscape(exportOpen, () => setExportOpen(false))
  useDropdownEscape(openingOpen !== null, () => setOpeningOpen(null))

  const area = useMemo(() => totalArea(plan), [plan])

  const canUndo = useStore(usePlanStore.temporal, (s) => s.pastStates.length > 0)
  const canRedo = useStore(
    usePlanStore.temporal,
    (s) => s.futureStates.length > 0,
  )

  const undo = () => usePlanStore.temporal.getState().undo()
  const redo = () => usePlanStore.temporal.getState().redo()

  const saveToStorage = () => {
    if (active === 'main') return
    useTabsStore.getState().saveProject(active)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const doExport = (kind: 'json' | 'png' | 'pdf') => {
    setExportOpen(false)
    const name = project?.name ?? 'floorplan'
    const modifiedAt =
      active !== 'main'
        ? useTabsStore.getState().lastModifiedAt(active)
        : Date.now()
    if (kind === 'json')
      exportPlanJSON(plan, name, modifiedAt, project?.description ?? '')
    else if (kind === 'png') exportPlanPNG(name, modifiedAt)
    else void exportPlanPDF(name, modifiedAt)
  }

  return (
    <div className="toolbar">
      <div className="group">
        <button
          className={`tool ${tool === 'select' ? 'active' : ''}`}
          onClick={() => setTool('select')}
        >
          선택
        </button>
        <div className="dropdown">
          <button
            className={`tool ${tool === 'wall' ? 'active' : ''}`}
            onClick={() => setWallOpen((o) => !o)}
          >
            {tool === 'wall' ? `벽: ${wallPick.label} ▾` : '벽 ▾'}
          </button>
          {wallOpen && (
            <>
              <div className="dropdown-backdrop" onMouseDown={() => setWallOpen(false)} />
              <div className="dropdown-menu">
                {WALL_PICKS.map((p) => (
                  <button
                    key={p.label}
                    className={
                      tool === 'wall' && wallPick.label === p.label
                        ? 'active'
                        : ''
                    }
                    onClick={() => {
                      setWallPick(p)
                      setTool('wall')
                      setWallOpen(false)
                    }}
                  >
                    <WallItemPreview pick={p} />
                    {p.label}
                    <span className="dd-size">
                      {WALL_THICKNESS[p.kind]}mm{p.transparent ? ' · 점선' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {(
          [
            ['문', 'door' as ToolId, DOOR_PICKS, doorPick],
            ['창', 'window' as ToolId, WINDOW_PICKS, windowPick],
          ] as const
        ).map(([title, toolId, picks, cur]) => (
          <div className="dropdown" key={toolId}>
            <button
              className={`tool ${tool === toolId ? 'active' : ''}`}
              onClick={() => setOpeningOpen((o) => (o === toolId ? null : toolId))}
            >
              {tool === toolId ? `${title}: ${cur.label} ▾` : `${title} ▾`}
            </button>
            {openingOpen === toolId && (
              <>
                <div
                  className="dropdown-backdrop"
                  onMouseDown={() => setOpeningOpen(null)}
                />
                <div className="dropdown-menu">
                  {picks.map((p) => (
                    <button
                      key={p.style}
                      className={
                        tool === toolId && cur.style === p.style ? 'active' : ''
                      }
                      onClick={() => {
                        setOpeningPick(p)
                        setTool(toolId)
                        setOpeningOpen(null)
                      }}
                    >
                      <OpeningItemPreview pick={p} />
                      {p.label}
                      <span className="dd-size">{p.width}mm</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
        {[
          ['가구', FURNITURE_PRESETS],
          ['가전', APPLIANCE_PRESETS],
          ['주방/욕실', FIXTURE_PRESETS],
        ].map(([title, presets]) => (
          <PresetDropdown
            key={title as string}
            title={title as string}
            presets={presets as FurniturePreset[]}
            active={
              tool === 'furniture' &&
              !!furniturePick &&
              (presets as FurniturePreset[]).some(
                (p) => p.label === furniturePick.label,
              )
            }
            pickedLabel={furniturePick?.label ?? null}
            onPick={(p) => {
              setFurniturePick(p)
              setTool('furniture')
            }}
          />
        ))}
      </div>

      <div className="divider" />

      <div className="group">
        <button className="tool" onClick={undo} disabled={!canUndo}>
          ↶ 실행취소
        </button>
        <button className="tool" onClick={redo} disabled={!canRedo}>
          ↷ 다시실행
        </button>
      </div>

      <div className="divider" />

      <div className="group">
        <button className="tool" onClick={saveToStorage} title="브라우저 저장소에 저장">
          {saved ? '저장됨 ✓' : '저장'}
        </button>
        <div className="dropdown">
          <button
            className="tool"
            onClick={() => setExportOpen((o) => !o)}
            title="파일로 다운로드"
          >
            내보내기 ▾
          </button>
          {exportOpen && (
            <>
              <div
                className="dropdown-backdrop"
                onMouseDown={() => setExportOpen(false)}
              />
              <div className="dropdown-menu">
                <button onClick={() => doExport('json')}>
                  도면 (JSON)
                </button>
                <button onClick={() => doExport('png')}>
                  PNG 이미지
                </button>
                <button onClick={() => doExport('pdf')}>
                  PDF 문서 <span className="dd-size">A4 가로</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="divider" />

      <button
        className={`tool ${showDims ? 'active' : ''}`}
        onClick={() => toggleDims()}
        title="외벽 자동 치수선 표시"
      >
        치수선
      </button>

      <button
        className={`tool ${debug ? 'active' : ''}`}
        onClick={() => toggleDebug()}
        title="방 감지 그래프 표시 (빨강=열린 끝점/틈, 초록=교차점)"
      >
        디버그
      </button>

      <span className="spacer" />
      <span className="hint">
        전체 면적: {formatArea(area)} ({(area / 1_000_000 / 3.305785).toFixed(1)} py)
      </span>
    </div>
  )
}
