import { useEffect, useRef, useState } from 'react'

function bytes(n) {
  if (n === '?') return '? B'
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

const SEG_DESCS = {
  stack: 'Local variables & call frames — grows downward, freed automatically on return',
  heap:  'Dynamic allocations via malloc() — you control lifetime, grows upward',
  bss:   'Uninitialized globals — zero-filled by the OS before main() runs',
  data:  'Initialized globals & statics — stored in the binary, live for the whole program',
  text:  'Compiled machine instructions — read-only, may be shared between processes',
}

function Segment({ className, title, arrow, desc, items, renderItem, emptyLabel }) {
  return (
    <div className={`mem-segment ${className}`}>
      <div className="mem-segment-header">
        <span>{title} {arrow && <span style={{ opacity: 0.6 }}>{arrow}</span>}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>
          {bytes(items.reduce((s, x) => s + (typeof x.size === 'number' ? x.size : 0), 0))}
        </span>
      </div>
      {desc && <div className="mem-seg-desc">{desc}</div>}
      <div className="mem-segment-body">
        {items.length === 0 && (
          <span style={{ fontSize: 11, opacity: 0.4, fontStyle: 'italic' }}>{emptyLabel}</span>
        )}
        {items.map((item, i) => renderItem(item, i))}
      </div>
    </div>
  )
}

function ByteSquares({ size, writtenAddrs, baseAddr }) {
  if (typeof size !== 'number' || size <= 0) return null
  const numSquares = Math.ceil(size / 4)
  return (
    <div className="byte-squares">
      {Array.from({ length: numSquares }, (_, i) => {
        const squareAddr = baseAddr + i * 4
        const written = writtenAddrs && writtenAddrs.has(squareAddr)
        return (
          <div
            key={i}
            className={`byte-sq${written ? ' written' : ''}`}
            title={`+${i * 4} bytes`}
          />
        )
      })}
    </div>
  )
}

function StackVarRow({ name, type, size, extra, spOffset, flashKey }) {
  const [flashing, setFlashing] = useState(false)
  const timerRef = useRef(null)
  const prevFlashKey = useRef(null)

  useEffect(() => {
    if (flashKey !== null && flashKey !== undefined && flashKey !== prevFlashKey.current) {
      prevFlashKey.current = flashKey
      setFlashing(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setFlashing(false), 600)
    }
    return () => clearTimeout(timerRef.current)
  }, [flashKey])

  return (
    <div className={`mem-var-row${flashing ? ' flash' : ''}`}>
      <span className="mem-var-name">{name}</span>
      <span className="mem-var-type">{type}</span>
      <span className="mem-var-size">{bytes(size)}</span>
      {extra && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{extra}</span>}
    </div>
  )
}

function VarRow({ name, type, size, extra }) {
  return (
    <div className="mem-var-row">
      <span className="mem-var-name">{name}</span>
      <span className="mem-var-type">{type}</span>
      <span className="mem-var-size">{bytes(size)}</span>
      {extra && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{extra}</span>}
    </div>
  )
}

export default function MemoryMap({ segments, loading, currentTraceStep }) {
  if (loading) return <div className="spinner">Compiling…</div>
  if (!segments) return <div className="placeholder">Compile C code to see memory layout</div>

  const { text = [], data = [], bss = [], heap = [], stack = [] } = segments

  // Build set of written sp_offsets from current trace step
  const writtenOffsets = new Set()
  if (currentTraceStep?.mem_writes) {
    for (const mw of currentTraceStep.mem_writes) {
      if (mw.sp_offset != null) writtenOffsets.add(mw.sp_offset)
    }
  }

  // Build set of written heap addrs from current trace step
  const writtenHeapAddrs = new Set()
  if (currentTraceStep?.mem_writes) {
    for (const mw of currentTraceStep.mem_writes) {
      if (mw.addr != null) writtenHeapAddrs.add(mw.addr)
    }
  }

  // Flatten all local vars for the stack segment display
  const stackVars = stack.flatMap(frame =>
    frame.vars.map(v => ({ ...v, fn: frame.function }))
  )

  // Build a flash key per var: increment when written
  // We use a stable counter approach via useRef at top level is not possible here,
  // so we pass the step identifier as flashKey and let StackVarRow handle dedup.
  const stepId = currentTraceStep?.step ?? null

  return (
    <div className="memory-map">
      <div className="mem-addr-label">↑ High addresses (0x7fff…)</div>

      {/* Stack */}
      <div className="mem-segment seg-stack">
        <div className="mem-segment-header">
          <span>STACK <span style={{ opacity: 0.6 }}>↓ grows down</span></span>
          <span style={{ fontSize: 10, opacity: 0.6 }}>
            {bytes(stackVars.reduce((s, v) => s + (typeof v.size === 'number' ? v.size : 0), 0))}
          </span>
        </div>
        <div className="mem-seg-desc">{SEG_DESCS.stack}</div>
        <div className="mem-segment-body">
          {stackVars.length === 0 && (
            <span style={{ fontSize: 11, opacity: 0.4, fontStyle: 'italic' }}>no local variables found</span>
          )}
          {stackVars.map((v, i) => {
            const wasWritten = v.sp_offset != null && writtenOffsets.has(v.sp_offset)
            return (
              <StackVarRow
                key={i}
                name={v.name}
                type={v.type}
                size={v.size}
                extra={`${v.fn}()`}
                spOffset={v.sp_offset}
                flashKey={wasWritten ? stepId : null}
              />
            )
          })}
        </div>
      </div>

      <div className="mem-gap">· · ·</div>

      {/* Heap */}
      <div className="mem-segment seg-heap">
        <div className="mem-segment-header">
          <span>HEAP <span style={{ opacity: 0.6 }}>↑ grows up</span></span>
          <span style={{ fontSize: 10, opacity: 0.6 }}>
            {bytes(heap.reduce((s, h) => s + (typeof h.size === 'number' ? h.size : 0), 0))}
          </span>
        </div>
        <div className="mem-seg-desc">{SEG_DESCS.heap}</div>
        <div className="mem-segment-body">
          {heap.length === 0 && (
            <span style={{ fontSize: 11, opacity: 0.4, fontStyle: 'italic' }}>no heap allocations found</span>
          )}
          {heap.map((h, i) => (
            <div key={i}>
              <VarRow
                name={`${h.call}()`}
                type={h.function}
                size={typeof h.size === 'number' ? h.size : 0}
                extra={`line ${h.line}`}
              />
              {typeof h.size === 'number' && h.size > 0 && (
                <ByteSquares
                  size={h.size}
                  writtenAddrs={writtenHeapAddrs}
                  baseAddr={0}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* BSS */}
      <Segment
        className="seg-bss"
        title="BSS"
        desc={SEG_DESCS.bss}
        items={bss}
        emptyLabel="no uninitialized globals"
        renderItem={(v, i) => (
          <VarRow key={i} name={v.name} type={v.type} size={v.size} extra="(zero-filled)" />
        )}
      />

      {/* Data */}
      <Segment
        className="seg-data"
        title="DATA"
        desc={SEG_DESCS.data}
        items={data}
        emptyLabel="no initialized globals"
        renderItem={(v, i) => (
          <VarRow key={i} name={v.name} type={v.type} size={v.size} extra={`= ${v.value}`} />
        )}
      />

      {/* Text */}
      <Segment
        className="seg-text"
        title="TEXT (code)"
        desc={SEG_DESCS.text}
        items={text}
        emptyLabel="no functions found"
        renderItem={(fn, i) => (
          <VarRow
            key={i}
            name={`${fn.name}()`}
            type="function"
            size={fn.size}
          />
        )}
      />

      <div className="mem-addr-label">↓ Low addresses (0x0000…)</div>
    </div>
  )
}
