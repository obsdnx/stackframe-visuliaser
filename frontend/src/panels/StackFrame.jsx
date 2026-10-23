const KINDS = {
  ret_addr: {
    color: '#f9e2af',
    bg: 'rgba(249,226,175,0.14)',
    border: 'rgba(249,226,175,0.45)',
    badge: 'ret addr',
    tip: 'Saved by the CPU on CALL. When RET/BL executes, the CPU jumps here to resume the caller. Stored in lr (x30) on ARM64, pushed to stack on x86.',
  },
  saved_fp: {
    color: '#fab387',
    bg: 'rgba(250,179,135,0.14)',
    border: 'rgba(250,179,135,0.45)',
    badge: 'frame ptr',
    tip: "The caller's frame pointer saved in the prologue (stp x29,x30 / push rbp). Restored on return so the caller can find its own local variables.",
  },
  var: {
    color: '#cba6f7',
    bg: 'rgba(203,166,247,0.11)',
    border: 'rgba(203,166,247,0.32)',
    badge: 'local',
    tip: 'Stack-allocated local variable. Space reserved in the function prologue (sub sp,sp,#N). Freed automatically when the frame is popped on return.',
  },
}

function kindOf(part) {
  if (part.kind === 'var') return 'var'
  if (part.label.toLowerCase().includes('return')) return 'ret_addr'
  return 'saved_fp'
}

function PartRow({ part, arch, showFpArrow }) {
  const k = KINDS[kindOf(part)]
  const fpReg = arch === 'x86_64' ? 'RBP' : 'FP'

  return (
    <div className="sf-row" style={{ background: k.bg, borderColor: k.border }} title={k.tip}>
      <span className="sf-row-offset">
        {part.sp_offset != null ? (part.offset_str ?? `sp+${part.sp_offset}`) : ''}
      </span>
      <span className="sf-row-label" style={{ color: k.color }}>{part.label}</span>
      <span className="sf-row-badge" style={{ color: k.color }}>{k.badge}</span>
      <span className="sf-row-size">{part.size}B</span>
      <span className="sf-row-ptr">
        {showFpArrow && <span style={{ color: '#fab387' }}>← {fpReg}</span>}
      </span>
    </div>
  )
}

function FrameCard({ frame, arch }) {
  const { function: name, frame_size, parts } = frame
  const spReg = arch === 'x86_64' ? 'RSP' : 'SP'

  // FP points to the last meta row (saved frame ptr, not return addr)
  let fpRowIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].kind === 'meta') { fpRowIdx = i; break }
  }

  return (
    <div className="sf-card">
      <div className="sf-card-header">
        <span className="sf-card-name">{name}()</span>
        <span className="sf-size-badge">
          {frame_size > 0 ? `${frame_size} bytes` : 'size unknown'}
        </span>
      </div>

      <div className="sf-addr-edge sf-addr-high">
        <span className="sf-addr-arrow">↑</span>
        <span>high address — caller&apos;s frame above this line</span>
      </div>

      {parts.length === 0 ? (
        <div className="sf-empty">no frame data</div>
      ) : (
        parts.map((part, i) => (
          <PartRow
            key={i}
            part={part}
            arch={arch}
            showFpArrow={i === fpRowIdx}
          />
        ))
      )}

      <div className="sf-sp-bar">
        <span className="sf-sp-reg">← {spReg}</span>
        <span className="sf-addr-low">↓ low address — stack grows this way</span>
      </div>
    </div>
  )
}

const LEGEND = [
  { color: '#f9e2af', label: 'Return address' },
  { color: '#fab387', label: 'Saved frame ptr' },
  { color: '#cba6f7', label: 'Local variable' },
]

export default function StackFrame({ stackFrames, loading, arch = 'arm64' }) {
  if (loading) return <div className="spinner">Compiling…</div>
  if (!stackFrames || stackFrames.length === 0) {
    return <div className="placeholder">Compile C code to see stack frames</div>
  }

  const archLabel = arch === 'x86_64' ? 'x86_64 · RBP-relative' : 'ARM64 · SP-relative'

  return (
    <div className="sf-panel">
      <div className="sf-legend">
        {LEGEND.map(l => (
          <span key={l.label} className="sf-legend-item">
            <span className="sf-legend-dot" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span className="sf-legend-arch">{archLabel}</span>
      </div>

      {stackFrames.map((frame, i) => (
        <FrameCard key={i} frame={frame} arch={arch} />
      ))}

      <div className="sf-hint">Hover any row for an explanation</div>
    </div>
  )
}
