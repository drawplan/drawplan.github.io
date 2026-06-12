import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type Konva from 'konva'
import { usePlanStore } from '../store/usePlanStore'
import ExportStage, { exportWorldSize, FOOTER_PX } from '../components/ExportStage'
import type { FloorPlan } from '../types/model'

export const formatDateTime = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function download(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}

/** Plan JSON with an export metadata header. Importers ignore `meta`. */
export function exportPlanJSON(
  plan: FloorPlan,
  name: string,
  modifiedAt: number,
  description = '',
) {
  const data = {
    meta: {
      app: 'drawplan',
      appVersion: __APP_VERSION_FULL__,
      name,
      description,
      modifiedAt: new Date(modifiedAt).toISOString(),
      exportedAt: new Date().toISOString(),
    },
    ...plan,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  download(url, `${name}.json`)
  URL.revokeObjectURL(url)
}

/** Render the current plan into an offscreen stage and return a PNG data URL.
 *  Selection/highlight/debug state is hidden for the snapshot and restored. */
function renderPlanImage(
  name: string,
  modifiedAt: number,
  longSidePx: number,
): { url: string; width: number; height: number } {
  const st = usePlanStore.getState()
  const prev = {
    selection: st.selection,
    wallProbe: st.wallProbe,
    roomPick: st.roomPick,
    debug: st.debug,
  }
  usePlanStore.setState({
    selection: [],
    wallProbe: null,
    roomPick: null,
    debug: false,
  })

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0'
  document.body.appendChild(host)
  const root = createRoot(host)
  let stage: Konva.Stage | null = null
  try {
    const { w, h } = exportWorldSize(st.plan, st.showDims)
    const drawW = w >= h ? longSidePx : Math.round((longSidePx * w) / h)
    const drawH = w >= h ? Math.round((longSidePx * h) / w) : longSidePx
    const width = Math.max(480, drawW) // keep room for the caption strip
    const height = drawH + FOOTER_PX
    flushSync(() => {
      root.render(
        <ExportStage
          width={width}
          height={height}
          footer={{
            name,
            modified: formatDateTime(modifiedAt),
            printed: formatDateTime(Date.now()),
          }}
          onStage={(s) => {
            stage = s
          }}
        />,
      )
    })
    if (!stage) throw new Error('export stage failed to mount')
    ;(stage as Konva.Stage).draw() // paint synchronously before capture
    const url = (stage as Konva.Stage).toDataURL({
      pixelRatio: 2,
      mimeType: 'image/png',
    })
    return { url, width, height }
  } finally {
    root.unmount()
    host.remove()
    usePlanStore.setState(prev)
  }
}

export function exportPlanPNG(name: string, modifiedAt: number) {
  const { url } = renderPlanImage(name, modifiedAt, 1600)
  download(url, `${name}.png`)
}

/** A4 landscape PDF with the plan image fitted inside 10 mm margins. */
export async function exportPlanPDF(name: string, modifiedAt: number) {
  const { url, width, height } = renderPlanImage(name, modifiedAt, 1600)
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const PAGE_W = 297
  const PAGE_H = 210
  const MARGIN = 10
  const k = Math.min((PAGE_W - 2 * MARGIN) / width, (PAGE_H - 2 * MARGIN) / height)
  const wMM = width * k
  const hMM = height * k
  doc.addImage(url, 'PNG', (PAGE_W - wMM) / 2, (PAGE_H - hMM) / 2, wMM, hMM)
  doc.save(`${name}.pdf`)
}
