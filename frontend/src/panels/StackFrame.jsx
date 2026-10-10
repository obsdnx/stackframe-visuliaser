function bytes(n) {
  if (typeof n !== 'number') return '?'
  return `${n}B`
}

function FrameCard({ frame, arch }) {
  const { function: name, frame_size, parts } = frame
  const frameLabel = arch === 'x86_64' ? 'rbp-relative' : 'sp-relative'

  return (
    <div className="frame-card">
      <div className="frame-card-header">
        <span>{name}()</span>
        <span className="frame-size-badge">
          {frame_size > 0 ? `${frame_size} bytes` : 'unknown size'}
        </span>
      </div>

      {parts.length === 0 ? (
        <div style={{ padding: '8px 10px', fontSize: 11, opacity: 0.5, fontStyle: 'italic' }}>
          no frame info
        </div>
      ) : (
        <>
          <div className="frame-high-addr-label">↑ high addr (caller&apos;s frame)</div>

          <table className="frame-table">
            <tbody>
              {parts.map((part, i) => (
                <tr
                  key={i}
                  className={part.kind === 'meta' ? 'frame-row-meta' : 'frame-row-var'}
                >
                  <td className="frame-col-label">{part.label}</td>
                  <td className="frame-col-size">{bytes(part.size)}</td>
                  <td className="frame-col-offset">
                    {part.kind === 'var' ? (part.sp_offset != null ? part.offset_str ?? `sp+${part.sp_offset}` : '??') : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="frame-sp-label">
            ← {arch === 'x86_64' ? 'rsp (stack pointer)' : 'sp (stack pointer)'}
          </div>
        </>
      )}
    </div>
  )
}

export default function StackFrame({ stackFrames, loading, arch = 'arm64' }) {
  if (loading) return <div className="spinner">Compiling…</div>
  if (!stackFrames || stackFrames.length === 0) {
    return <div className="placeholder">Compile C code to see stack frames</div>
  }

  const archLabel = arch === 'x86_64' ? 'x86_64 · rbp frame pointer' : 'ARM64 · sp-relative'

  return (
    <div className="stack-frame-panel">
      <div className="frame-meta-label">
        One frame per function · rows high → low address · {archLabel}
      </div>
      {stackFrames.map((frame, i) => (
        <FrameCard key={i} frame={frame} arch={arch} />
      ))}
    </div>
  )
}
