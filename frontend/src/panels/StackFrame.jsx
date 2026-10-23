const KINDS = {
  ret_addr: {
    color: '#f9e2af',
    bg: 'rgba(249,226,175,0.15)',
    border: 'rgba(249,226,175,0.5)',
    badge: 'ret addr',
    tip: 'Return address saved by the CPU on CALL/BL. When RET executes, the CPU jumps here to resume the caller.',
  },
  saved_fp: {
    color: '#fab387',
    bg: 'rgba(250,179,135,0.15)',
    border: 'rgba(250,179,135,0.5)',
    badge: 'frame ptr',
    tip: "Caller's frame pointer (FP/RBP) saved in the prologue. Restored on return so the caller can find its own locals.",
  },
  var: {
    color: '#cba6f7',
    bg: 'rgba(203,166,247,0.12)',
    border: 'rgba(203,166,247,0.35)',
    badge: 'local',
    tip: 'Stack-allocated local variable. Space reserved in the prologue (sub sp / subq rsp), freed automatically on return.',
  },
}

function kindOf(part) {
  if (part.kind === 'var') return 'var'
  if (part.label.toLowerCase().includes('return')) return 'ret_addr'
  return 'saved_fp'
}

function PartRow({ part, arch, showFpArrow, active, written }) {
  const k = KINDS[kindOf(part)]
  const fpReg = arch === 'x86_64' ? 'RBP' : 'FP'

  return (
    <div
      className={`sf2-row${written ? ' sf2-row-written' : ''}`}
      style={{
        background: active ? k.bg : 'rgba(255,255,255,0.025)',
        borderLeft: `2px solid ${active ? k.border : 'rgba(255,255,255,0.07)'}`,
      }}
      title={k.tip}
    >
      <span className="sf2-offset" style={{ color: active ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.18)' }}>
        {part.sp_offset != null ? (part.offset_str ?? `+${part.sp_offset}`) : ''}
      </span>
      <span className="sf2-label" style={{ color: active ? k.color : 'rgba(255,255,255,0.28)' }}>
        {part.label}
      </span>
      <span
        className="sf2-badge"
        style={{
          color: active ? k.color : 'rgba(255,255,255,0.2)',
          background: active ? k.bg : 'transparent',
          borderColor: active ? k.border : 'rgba(255,255,255,0.08)',
        }}
      >
        {k.badge}
      </span>
      <span className="sf2-size" style={{ color: active ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.18)' }}>
        {part.size}B
      </span>
      {showFpArrow && (
        <span className="sf2-fp-arrow" style={{ color: active ? '#fab387' : 'rgba(250,179,135,0.25)' }}>
          ← {fpReg}
        </span>
      )}
    </div>
  )
}

function FrameBlock({ frame, active, arch, writtenOffsets }) {
  const { function: name, frame_size, parts } = frame

  let fpRowIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].kind === 'meta') { fpRowIdx = i; break }
  }

  return (
    <div className={`sf2-frame${active ? ' sf2-frame-active' : ' sf2-frame-inactive'}`}>
      <div className={`sf2-frame-hdr${active ? ' sf2-frame-hdr-active' : ''}`}>
        <span className="sf2-func-name">{name}()</span>
        {active
          ? <span className="sf2-badge-active">● ACTIVE</span>
          : <span className="sf2-badge-inactive">INACTIVE</span>}
        <span className="sf2-frame-size">{frame_size > 0 ? `${frame_size}B` : '?'}</span>
      </div>

      {parts.length === 0
        ? <div className="sf2-no-data">no frame data</div>
        : parts.map((part, i) => (
          <PartRow
            key={i}
            part={part}
            arch={arch}
            showFpArrow={i === fpRowIdx}
            active={active}
            written={active && part.sp_offset != null && writtenOffsets.has(part.sp_offset)}
          />
        ))
      }

      {/* Yellow return-link row shown at the bottom of each inactive frame */}
      {!active && (
        <div className="sf2-ret-link">↓ return link to {name}()</div>
      )}
    </div>
  )
}

const LEGEND = [
  { color: '#f9e2af', label: 'Return address' },
  { color: '#fab387', label: 'Saved frame ptr' },
  { color: '#cba6f7', label: 'Local variable' },
]

export default function StackFrame({
  stackFrames,
  loading,
  arch = 'arm64',
  callStack = [],
  traceStep,
}) {
  if (loading) return <div className="spinner">Compiling…</div>
  if (!stackFrames || stackFrames.length === 0) {
    return <div className="placeholder">Compile C code to see stack frames</div>
  }

  const spReg = arch === 'x86_64' ? 'RSP' : 'SP'
  const archLabel = arch === 'x86_64' ? 'x86_64 · RBP-relative' : 'ARM64 · SP-relative'

  // Build a name→frame lookup (js-index-maps pattern)
  const frameMap = new Map(stackFrames.map(f => [f.function, f]))

  const hasTrace = callStack.length > 0

  // Which frames to render, top→bottom (oldest/highest addr first)
  const visibleNames = hasTrace ? callStack : stackFrames.map(f => f.function)
  const activeFunc = hasTrace ? callStack[callStack.length - 1] : null

  // Offsets written this step (for variable flash highlight)
  const writtenOffsets = new Set()
  if (traceStep?.mem_writes) {
    for (const mw of traceStep.mem_writes) {
      if (mw.sp_offset != null) writtenOffsets.add(mw.sp_offset)
    }
  }

  // Current SP value for the SP marker
  const rawSp = traceStep?.registers?.sp ?? traceStep?.registers?.rsp
  const spHex = rawSp
    ? `0x${parseInt(rawSp, 16).toString(16).toUpperCase().padStart(8, '0').slice(-8)}`
    : null

  const isReturning = /^ret[q]?\b/.test(traceStep?.instruction?.trim() ?? '')

  return (
    <div className="sf2-panel">
      <div className="sf2-legend">
        {LEGEND.map(l => (
          <span key={l.label} className="sf2-legend-item">
            <span className="sf2-legend-dot" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span className="sf2-legend-arch">{archLabel}</span>
      </div>

      {/* High-address origin bar */}
      <div className="sf2-origin">
        <span className="sf2-origin-arrow">↑</span>
        stack origin · high address
      </div>

      {/* Frame blocks — main at top, active function at bottom */}
      <div className="sf2-frames">
        {visibleNames.map(name => {
          const frame = frameMap.get(name)
          if (!frame) return null
          return (
            <FrameBlock
              key={name}
              frame={frame}
              active={!hasTrace || name === activeFunc}
              arch={arch}
              writtenOffsets={writtenOffsets}
            />
          )
        })}
      </div>

      {/* SP line — only when trace is active */}
      {hasTrace && (
        <div className={`sf2-sp-line${isReturning ? ' sf2-sp-returning' : ''}`}>
          <span className="sf2-sp-reg">← {spReg}</span>
          {spHex && <span className="sf2-sp-val">{spHex}</span>}
        </div>
      )}

      {/* Available stack space */}
      {hasTrace && (
        <div className="sf2-available">
          <span className="sf2-avail-text">· · · available stack space · · ·</span>
        </div>
      )}

      {!hasTrace && (
        <div className="sf2-hint">Step through the trace to see frames animate live</div>
      )}
    </div>
  )
}
