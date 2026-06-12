import { Component, useState, type ReactNode } from 'react'
import Toolbar from './components/Toolbar'
import Canvas from './components/Canvas'
import TabBar from './components/TabBar'
import MainTab from './components/MainTab'
import { useTabsStore } from './store/useTabsStore'
import { usePlanStore } from './store/usePlanStore'

/** Keeps an editor crash from white-screening the app: shows the error so it
 *  can be reported, while the saved data stays untouched in localStorage. */
class EditorErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="error-pane">
          <h3>⚠️ 도면을 표시하는 중 오류가 발생했습니다</h3>
          <p>
            저장된 데이터는 그대로 남아 있습니다. 메인 탭의 ⬇ 버튼으로 JSON을
            내려받아 보관한 뒤, 아래 오류 내용을 알려주세요.
          </p>
          <pre>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button className="tool" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function RecoveryBanner() {
  const active = useTabsStore((s) => s.active)
  const recoveredId = useTabsStore((s) => s.recoveredId)
  const dismiss = useTabsStore((s) => s.dismissRecovery)
  const discard = useTabsStore((s) => s.discardRecovery)
  if (!recoveredId || recoveredId !== active) return null
  return (
    <div className="recover-banner">
      <span>💡 자동 저장된 변경 내용을 복구했습니다.</span>
      <button className="tool" onClick={discard}>
        저장본으로 되돌리기
      </button>
      <button className="tool primary" onClick={dismiss}>
        유지
      </button>
    </div>
  )
}

const HELP_LINES = [
  '휠: 확대/축소',
  '휠 드래그: 화면 이동',
  'Space+마우스 이동: 화면 이동',
  '클릭: 선택',
  '드래그: 이동/크기조절',
  '빈 곳 드래그: 영역 선택',
  '빈 곳 Ctrl+드래그: 선택에 추가',
  'Ctrl+드래그: 복사',
  'Ctrl+클릭: 다중 선택',
  '우클릭: 속성 편집',
  'Del: 삭제',
  '방향키: 10mm 이동 (Ctrl=100)',
  'Ctrl+Z: 실행취소',
  'Esc: 취소',
]

/** Marquee drag size readout, floating left of the help button. */
function MarqueeSizeBadge() {
  const size = usePlanStore((s) => s.marqueeSize)
  if (!size) return null
  return (
    <div className="marquee-size">
      {Math.round(size.w)} × {Math.round(size.h)} mm
    </div>
  )
}

/** Floating "?" button at the right edge; clicking opens the shortcut list. */
function HelpWidget() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {open && (
        <div className="help-pop">
          {HELP_LINES.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      <button
        className={`help-fab ${open ? 'active' : ''}`}
        title="단축키 도움말"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
    </>
  )
}

export default function App() {
  const active = useTabsStore((s) => s.active)
  return (
    <div className="app">
      <TabBar />
      {active === 'main' ? (
        <MainTab />
      ) : (
        <EditorErrorBoundary key={active}>
          <Toolbar />
          <RecoveryBanner />
          <Canvas key={active} />
          <MarqueeSizeBadge />
          <HelpWidget />
        </EditorErrorBoundary>
      )}
    </div>
  )
}
