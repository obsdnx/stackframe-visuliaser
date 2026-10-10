import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { StreamLanguage } from '@codemirror/language'
import { gas } from '@codemirror/legacy-modes/mode/gas'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorState } from '@codemirror/state'
import { buildVarMap } from '../utils/explainInstruction'

const gasLang = StreamLanguage.define(gas)

const cmTheme = EditorView.theme({
  '&': { height: '100%', background: '#1e1e2e' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { padding: '8px 0' },
  '&.cm-focused': { outline: 'none' },
})

function makeState(doc) {
  return EditorState.create({
    doc: doc || '',
    extensions: [basicSetup, gasLang, oneDark, cmTheme, EditorState.readOnly.of(true)],
  })
}

// ── gcc -S view: CodeMirror with typewriter animation ──────────────────────
function GccAssemblyView({ assembly }) {
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  const [displayed, setDisplayed] = useState('')
  const animRef = useRef(null)

  useEffect(() => {
    if (!assembly) { setDisplayed(''); return }
    const lines = assembly.split('\n')
    let count = 0
    setDisplayed('')
    clearInterval(animRef.current)
    animRef.current = setInterval(() => {
      count = Math.min(count + 6, lines.length)
      setDisplayed(lines.slice(0, count).join('\n'))
      if (count >= lines.length) clearInterval(animRef.current)
    }, 18)
    return () => clearInterval(animRef.current)
  }, [assembly])

  useEffect(() => {
    if (!containerRef.current) return
    const view = new EditorView({ state: makeState(''), parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [])

  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.setState(makeState(displayed))
  }, [displayed])

  return <div ref={containerRef} style={{ height: '100%', minHeight: 0 }} />
}

// ── Trace view: plain list with big arrow + inline memory badges ───────────
function TraceAssemblyView({ lines, highlightLine, traceStep, segments, arch }) {
  const containerRef = useRef(null)
  const writes = traceStep?.mem_writes || []
  const varMap = buildVarMap(segments)
  const isX86 = arch === 'x86_64'

  useEffect(() => {
    if (highlightLine == null || !containerRef.current) return
    const el = containerRef.current.querySelector(`[data-idx="${highlightLine}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlightLine])

  return (
    <div ref={containerRef} className="trace-asm-view">
      {lines.map((line, i) => {
        const active = i === highlightLine
        const lineWrites = active ? writes : []
        const isLabel = /^[a-zA-Z_]/.test(line.trim()) && line.trim().endsWith(':')
        const isEmpty = !line.trim()

        if (isEmpty) return <div key={i} className="trace-asm-spacer" />
        if (isLabel) return (
          <div key={i} className="trace-asm-label" data-idx={i}>{line}</div>
        )

        return (
          <div key={i} data-idx={i} className={`trace-asm-line${active ? ' active' : ''}`}>
            <span className="trace-arrow">{active ? '▶' : ''}</span>
            <span className="trace-instr">{line.replace(/^\t/, '')}</span>
            {lineWrites.length > 0 && (
              <span className="trace-mem-writes">
                {lineWrites.map((w, j) => {
                  const v = varMap?.[w.sp_offset]
                  let label
                  if (v) {
                    label = `${v.name} = ${w.value}`
                  } else if (isX86 && w.sp_offset < 0) {
                    label = `[rbp${w.sp_offset}] = ${w.value}`
                  } else {
                    label = `[sp+${w.sp_offset}] = ${w.value}`
                  }
                  return <span key={j} className="trace-mem-badge">{label}</span>
                })}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function AssemblyPanel({
  assembly,       // gcc -S output (always set after compile)
  disassembly,    // otool output (only when tracing)
  traceStep,      // current trace step object
  highlightLine,  // line index to highlight
  segments,       // for varMap in trace view
  arch,
  error,
  loading,
}) {
  const traceMode = !!disassembly
  const traceLines = traceMode ? disassembly.split('\n') : []

  if (loading) return <div className="spinner">Compiling…</div>
  if (error && !assembly && !disassembly) return <div className="error-box">{error}</div>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {error && <div className="error-box" style={{ margin: '8px', fontSize: '11px' }}>{error}</div>}

      <div className="asm-mode-bar">
        <span className="asm-mode-badge">{traceMode ? 'otool · linked binary' : 'gcc -S · source assembly'}</span>
        {traceMode && <span className="asm-mode-hint">step controls active ↑</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {traceMode
          ? <TraceAssemblyView
              lines={traceLines}
              highlightLine={highlightLine}
              traceStep={traceStep}
              segments={segments}
              arch={arch}
            />
          : <GccAssemblyView assembly={assembly} />
        }
      </div>
    </div>
  )
}
