import { Circle, Ellipse, Group, Line, Path, Rect } from 'react-konva'
import { usePlanStore } from '../store/usePlanStore'
import { worldToScreen, type Viewport } from '../geometry/viewport'
import type { Furniture } from '../types/model'

const FILL = '#ffffff'
const STROKE = '#5a6472'
const SELECTED = '#2f6df0'

type Pose = Pick<
  Furniture,
  'kind' | 'center' | 'width' | 'depth' | 'rotation' | 'flipH' | 'flipV'
>

/** Top-view symbol of one furniture piece. Drawn in local mm coordinates
 *  (origin at the center, back edge at -y) inside a scaled+rotated group, so
 *  the shapes themselves stay resolution independent. */
export function FurnitureSymbol({
  f,
  viewport,
  stroke,
  opacity,
  bold,
}: {
  f: Pose
  viewport: Viewport
  stroke: string
  opacity?: number
  bold?: boolean // selected: slightly thicker strokes, like openings
}) {
  const p = worldToScreen(f.center, viewport)
  const hw = f.width / 2
  const hd = f.depth / 2
  const body = {
    // selected: light sky-blue body so the piece stands out
    fill: bold ? '#d7e6ff' : FILL,
    stroke,
    strokeWidth: bold ? 2.2 : 1.4,
    strokeScaleEnabled: false,
  }
  const detail = {
    stroke,
    strokeWidth: bold ? 1.7 : 1.1,
    strokeScaleEnabled: false,
  }

  const shapes: JSX.Element[] = []
  switch (f.kind) {
    case 'desk': {
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
        <Line key="l" points={[-hw, -hd + 150, hw, -hd + 150]} {...detail} />,
      )
      break
    }
    case 'dining': {
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.min(60, hw, hd)}
          {...body}
        />,
      )
      break
    }
    case 'chair': {
      // backrest bar + seat with rounded front corners; tiny chairs drop the
      // backrest (negative rect sizes make Konva's rounded-rect arc throw)
      const hasBack = f.depth >= 160 && f.width >= 60
      const seatY = hasBack ? -hd + 110 : -hd
      const seatH = hd - seatY
      const seatR = Math.max(0, Math.min(120, hw, seatH / 2))
      const backR = Math.max(0, Math.min(30, hw, seatH / 2))
      if (hasBack) {
        shapes.push(
          <Rect
            key="back"
            x={-hw + 20}
            y={-hd}
            width={f.width - 40}
            height={100}
            cornerRadius={Math.max(0, Math.min(45, (f.width - 40) / 2, 50))}
            {...body}
          />,
        )
      }
      shapes.push(
        <Rect
          key="seat"
          x={-hw}
          y={seatY}
          width={f.width}
          height={seatH}
          cornerRadius={[backR, backR, seatR, seatR]}
          {...body}
        />,
      )
      break
    }
    case 'bed': {
      const pillows = f.width >= 1300 ? 2 : 1
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.max(0, Math.min(40, hw, hd))}
          {...body}
        />,
      )
      const pw = Math.min(600, f.width - 260)
      if (pw > 40 && f.depth >= 600) {
        if (pillows === 2) {
          shapes.push(
            <Rect key="p1" x={-hw + 130} y={-hd + 100} width={pw} height={350} cornerRadius={80} {...body} />,
            <Rect key="p2" x={hw - 130 - pw} y={-hd + 100} width={pw} height={350} cornerRadius={80} {...body} />,
          )
        } else {
          shapes.push(
            <Rect key="p" x={-pw / 2} y={-hd + 100} width={pw} height={350} cornerRadius={80} {...body} />,
          )
        }
      }
      if (f.depth >= 800) {
        shapes.push(
          <Line key="cover" points={[-hw, -hd + 650, hw, -hd + 650]} {...detail} />,
        )
      }
      shapes.push(
        <Line key="fold" points={[hw - 300, hd, hw, hd - 300]} {...detail} />,
      )
      break
    }
    case 'sofa': {
      const arm = 130
      const backD = 180
      const seats = Math.max(1, Math.round(f.width / 800))
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.min(120, hw, hd)}
          {...body}
        />,
        <Line key="back" points={[-hw + arm, -hd + backD, hw - arm, -hd + backD]} {...detail} />,
        <Line key="a1" points={[-hw + arm, -hd, -hw + arm, hd]} {...detail} />,
        <Line key="a2" points={[hw - arm, -hd, hw - arm, hd]} {...detail} />,
      )
      const seatW = (f.width - 2 * arm) / seats
      for (let i = 1; i < seats; i++) {
        const x = -hw + arm + seatW * i
        shapes.push(
          <Line key={`s${i}`} points={[x, -hd + backD, x, hd]} {...detail} />,
        )
      }
      break
    }
    case 'table': {
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.min(60, hw, hd)}
          {...body}
        />,
      )
      break
    }
    case 'sink': {
      // plain counter — sink bowls / cooktops are separate objects (planned)
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      break
    }
    case 'cabinet': {
      // casework symbol: rectangle with a single diagonal (like 신발장)
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
        <Line key="d" points={[-hw, -hd, hw, hd]} {...detail} />,
      )
      break
    }
    case 'shoe': {
      // rectangle with a single diagonal
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
        <Line key="d" points={[-hw, -hd, hw, hd]} {...detail} />,
      )
      break
    }
    case 'tv': {
      // slim body + screen line along the front + centre stand at the back
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      if (f.depth >= 90 && f.width > 140) {
        shapes.push(
          <Line key="s" points={[-hw + 50, hd - 45, hw - 50, hd - 45]} {...detail} />,
        )
      }
      const stw = Math.min(180, f.width - 80)
      const std = Math.min(45, f.depth - 60)
      if (stw > 20 && std > 10) {
        shapes.push(
          <Rect key="st" x={-stw / 2} y={-hd + 15} width={stw} height={std} {...detail} />,
        )
      }
      break
    }
    case 'fridge': {
      // box + front door line + centre split (french door)
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      if (f.depth >= 180) {
        shapes.push(
          <Line key="door" points={[-hw, hd - 90, hw, hd - 90]} {...detail} />,
          <Line key="split" points={[0, hd - 90, 0, hd]} {...detail} />,
        )
      }
      break
    }
    case 'washer': {
      // box + control panel line at the back + drum circles
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      if (f.depth >= 260) {
        shapes.push(
          <Line key="panel" points={[-hw, -hd + 130, hw, -hd + 130]} {...detail} />,
        )
        const r = Math.min(f.width, f.depth - 130) / 2 - 60
        if (r > 40) {
          const cy = -hd + 130 + (f.depth - 130) / 2
          shapes.push(
            <Circle key="drum" x={0} y={cy} radius={r} {...detail} />,
            <Circle key="hub" x={0} y={cy} radius={r * 0.37} {...detail} />,
          )
        }
      }
      break
    }
    case 'aircon': {
      // box + outlet louvres toward the front
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      if (f.depth >= 200 && f.width > 140) {
        for (const off of [30, 75, 120]) {
          shapes.push(
            <Line
              key={`v${off}`}
              points={[-hw + 60, hd - off, hw - 60, hd - off]}
              {...detail}
            />,
          )
        }
      }
      break
    }
    case 'cooktop': {
      // counter-top unit: 2x2 burners when wide enough, else 2 in a column
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      const r = Math.min(90, f.width / 4, f.depth / 6)
      if (r > 25) {
        const spots: [number, number][] =
          f.width >= 500
            ? [[-1, -1], [1, -1], [-1, 1], [1, 1]]
            : [[0, -1], [0, 1]]
        for (const [sx, sy] of spots) {
          shapes.push(
            <Circle
              key={`bn${sx}${sy}`}
              x={(sx * f.width) / 4}
              y={(sy * f.depth) / 4}
              radius={r}
              {...detail}
            />,
          )
        }
      }
      break
    }
    case 'sinkbowl': {
      // top-mount sink: flange + bowl (wider ledge at the faucet side) +
      // concentric drain + faucet hole
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.max(0, Math.min(20, hw, hd))}
          {...body}
        />,
      )
      const bw = f.width - 100
      const bd = f.depth - 120
      if (bw > 40 && bd > 40) {
        shapes.push(
          <Rect
            key="bowl"
            x={-hw + 50}
            y={-hd + 80}
            width={bw}
            height={bd}
            cornerRadius={Math.max(0, Math.min(45, bw / 2, bd / 2))}
            {...detail}
          />,
        )
        const cy = -hd + 80 + bd / 2
        const dr = Math.min(55, bw / 4, bd / 4)
        if (dr > 20) {
          shapes.push(
            <Circle key="d1" x={0} y={cy} radius={dr} {...detail} />,
            <Circle key="d2" x={0} y={cy} radius={dr * 0.47} {...detail} />,
          )
        }
        shapes.push(<Circle key="tap" x={0} y={-hd + 40} radius={16} {...detail} />)
      }
      break
    }
    case 'basin': {
      // pedestal basin: flat-ish back, round front + inner oval + faucet
      const tr = Math.min(55, hw, hd)
      const yMid = hd - Math.min(185, f.depth * 0.5) // round-bottom zone
      shapes.push(
        <Path
          key="b"
          data={`M ${-hw} ${-hd + tr} Q ${-hw} ${-hd} ${-hw + tr} ${-hd} L ${hw - tr} ${-hd} Q ${hw} ${-hd} ${hw} ${-hd + tr} L ${hw} ${yMid} Q ${hw} ${hd} 0 ${hd} Q ${-hw} ${hd} ${-hw} ${yMid} Z`}
          {...body}
        />,
      )
      const rx = Math.min(200, hw - 50)
      const ry = Math.min(150, hd - 35)
      if (rx > 20 && ry > 20) {
        shapes.push(
          <Ellipse key="bowl" x={0} y={yMid} radiusX={rx} radiusY={ry} {...detail} />,
          <Circle key="tap" x={0} y={-hd + 32} radius={18} {...detail} />,
        )
      }
      break
    }
    case 'basinCounter': {
      // vanity counter + oval bowl + faucet
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      const rx = Math.min(200, hw - 70)
      const ry = Math.min(150, hd - 90)
      if (rx > 20 && ry > 20) {
        shapes.push(
          <Ellipse
            key="bowl"
            x={0}
            y={f.depth * 0.05}
            radiusX={rx}
            radiusY={ry}
            {...detail}
          />,
          <Circle key="tap" x={0} y={-hd + 90} radius={25} {...detail} />,
        )
      }
      break
    }
    case 'toilet': {
      // full-width cistern at the wall + bowl ellipse flush below it
      const tankD = Math.min(250, f.depth / 3)
      shapes.push(
        <Rect
          key="tank"
          x={-hw}
          y={-hd}
          width={f.width}
          height={tankD}
          cornerRadius={Math.max(0, Math.min(30, hw, tankD / 2))}
          {...body}
        />,
      )
      const ry = (f.depth - tankD) / 2
      const rx = Math.min(hw - 25, ry * 0.7)
      if (rx > 20 && ry > 20) {
        shapes.push(
          <Ellipse
            key="bowl"
            x={0}
            y={-hd + tankD + ry}
            radiusX={rx}
            radiusY={ry}
            {...body}
          />,
        )
      }
      break
    }
    case 'bathtub': {
      // rounded shell + inner outline (round at the foot end) + drain
      shapes.push(
        <Rect
          key="b"
          x={-hw}
          y={-hd}
          width={f.width}
          height={f.depth}
          cornerRadius={Math.max(0, Math.min(80, hw, hd))}
          {...body}
        />,
      )
      if (f.width > 300 && f.depth > 500) {
        const inX = hw - 130
        const top = -hd + 130
        const yMid = hd - 370
        const front = hd - 70
        shapes.push(
          <Path
            key="in"
            data={`M ${-inX} ${top} L ${inX} ${top} L ${inX} ${yMid} Q ${inX} ${front} 0 ${front} Q ${-inX} ${front} ${-inX} ${yMid} Z`}
            {...detail}
          />,
          <Circle key="drain" x={0} y={-hd + 230} radius={40} {...detail} />,
        )
      }
      break
    }
    case 'shower': {
      // overhead view: arm out of the wall (50x100) + round head (Ø100),
      // 100x200 total — the head hangs into the room
      const r = Math.max(10, Math.min(hd, hw)) // head fills the width
      const armL = f.depth - 2 * r
      const at = Math.min(50, f.width / 2) // arm thickness
      if (armL > 1) {
        shapes.push(
          <Rect key="arm" x={-at / 2} y={-hd} width={at} height={armL} {...body} />,
        )
      }
      const cy = hd - r
      shapes.push(<Circle key="b" x={0} y={cy} radius={r} {...body} />)
      if (r > 30) {
        shapes.push(<Circle key="i" x={0} y={cy} radius={r * 0.62} {...detail} />)
      }
      shapes.push(
        <Circle key="c" x={0} y={cy} radius={Math.max(3, r * 0.12)} {...detail} />,
      )
      break
    }
    case 'hood': {
      // range hood above the cooktop: duct circle at the back + front grille
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
      )
      const r = Math.min(90, f.width / 4, f.depth / 4)
      shapes.push(
        <Circle
          key="duct"
          x={0}
          y={-hd + Math.min(160, f.depth * 0.32)}
          radius={r}
          {...detail}
        />,
      )
      const inset = Math.min(80, f.width * 0.1)
      for (let i = 0; i < 3; i++) {
        const y = hd - 40 - i * 60
        if (y < -hd + f.depth * 0.32 + r + 20) break // keep clear of the duct
        shapes.push(
          <Line
            key={`g${i}`}
            points={[-hw + inset, y, hw - inset, y]}
            {...detail}
          />,
        )
      }
      break
    }
    case 'showerPartition': {
      // glass partition: the logical width (100mm) is just the grab/snap
      // zone — the pane itself is drawn 20mm thick, centred
      const t = Math.min(20, f.width)
      shapes.push(
        <Rect key="b" x={-t / 2} y={-hd} width={t} height={f.depth} {...body} />,
      )
      break
    }
    case 'wardrobe': {
      shapes.push(
        <Rect key="b" x={-hw} y={-hd} width={f.width} height={f.depth} {...body} />,
        <Line key="rod" points={[-hw + 50, 0, hw - 50, 0]} {...detail} />,
      )
      // hangers on the rod
      const span = Math.min(170, hd - 130)
      if (span <= 20) break
      for (let x = -hw + 150, i = 0; x <= hw - 150; x += 150, i++) {
        shapes.push(
          <Line
            key={`h${i}`}
            points={[x, -span, x, span]}
            stroke="#8a91a0"
            strokeWidth={1.1}
            strokeScaleEnabled={false}
            dash={[60, 50]}
          />,
        )
      }
      break
    }
  }

  return (
    <Group
      x={p.x}
      y={p.y}
      rotation={f.rotation}
      scaleX={viewport.scale * (f.flipH ? -1 : 1)}
      scaleY={viewport.scale * (f.flipV ? -1 : 1)}
      opacity={opacity ?? 1}
      listening={false}
    >
      {shapes}
    </Group>
  )
}

/** All placed furniture; selection is highlighted in blue. */
export default function FurnitureLayer({ viewport }: { viewport: Viewport }) {
  const furniture = usePlanStore((s) => s.plan.furniture)
  const selection = usePlanStore((s) => s.selection)
  const selected = new Set(selection)
  return (
    <>
      {Object.values(furniture ?? {}).map((f) => (
        <FurnitureSymbol
          key={f.id}
          f={f}
          viewport={viewport}
          stroke={selected.has(f.id) ? SELECTED : STROKE}
          bold={selected.has(f.id)}
        />
      ))}
    </>
  )
}
