import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import './App.css'
import CodeEditor from './panels/CodeEditor'
import AssemblyPanel from './panels/AssemblyPanel'
import MemoryMap from './panels/MemoryMap'
import StackFrame from './panels/StackFrame'
import RegisterPanel from './panels/RegisterPanel'
import StepControls from './components/StepControls'
import { buildVarMap, explainInstruction } from './utils/explainInstruction'

const DEFAULT_CODE = `#include <stdio.h>
#include <stdlib.h>

/* Initialized globals → DATA segment */
int global_count = 42;
float pi_approx = 3.14;

/* Uninitialized global → BSS segment */
int uninitialized_global;

/* Functions → TEXT segment */
int add(int a, int b) {
    int result = a + b;
    return result;
}

int multiply(int x, int y) {
    int product = x * y;
    int doubled = product * 2;
    return doubled;
}

int main() {
    /* Local vars → STACK */
    int local_x = 10;
    int local_y = 20;
    int sum;
    double ratio = 1.618;

    /* Heap allocation */
    int *array = (int *)malloc(5 * sizeof(int));

    sum = add(local_x, local_y);

    for (int i = 0; i < 5; i++) {
        array[i] = multiply(sum, i);
    }

    free(array);
    return 0;
}
`

const ARCHES = [
  { id: 'arm64',  label: 'ARM64',  sub: 'Apple Silicon' },
  { id: 'x86_64', label: 'x86_64', sub: 'Intel / AMD'  },
]

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export default function App() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [arch, setArch] = useState('arm64')

  const [trace, setTrace] = useState(null)
  const [disassembly, setDisassembly] = useState(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(150)
  const [traceLoading, setTraceLoading] = useState(false)

  const handleArchChange = useCallback((newArch) => {
    setArch(newArch)
    // Reset everything so the user knows they need to recompile
    setResult(null)
    setTrace(null)
    setDisassembly(null)
    setCurrentStep(0)
    setPlaying(false)
    setError(null)
  }, [])

  const handleCompile = useCallback(async () => {
    setLoading(true)
    setError(null)
    setTrace(null)
    setDisassembly(null)
    setCurrentStep(0)
    setPlaying(false)

    try {
      const res = await fetch(`${API_BASE}/api/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, arch }),
      })

      const data = await res.json()

      if (data.error && !data.assembly) {
        setError(data.error)
        setResult(null)
        setLoading(false)
        return
      }

      setResult(data)
      setError(data.error || null)
      setLoading(false)

      // Trace is ARM64-only; still fire the request so we get a clean error message
      setTraceLoading(true)
      try {
        const traceRes = await fetch(`${API_BASE}/api/trace`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, arch }),
        })
        const traceData = await traceRes.json()
        if (traceData.trace && traceData.trace.length > 0) {
          setTrace(traceData.trace)
          setDisassembly(traceData.disassembly)
          setCurrentStep(0)
        }
      } catch (traceErr) {
        console.warn('Trace failed:', traceErr.message)
      } finally {
        setTraceLoading(false)
      }
    } catch (err) {
      setError(`Network error: ${err.message}\n\nIs the backend running?\n  cd backend && venv/bin/python app.py`)
      setLoading(false)
    }
  }, [code, arch])

  const playIntervalRef = useRef(null)
  useEffect(() => {
    if (playing && trace) {
      playIntervalRef.current = setInterval(() => {
        setCurrentStep(s => {
          if (s >= trace.length - 1) {
            setPlaying(false)
            return s
          }
          return s + 1
        })
      }, playSpeed)
    } else {
      clearInterval(playIntervalRef.current)
    }
    return () => clearInterval(playIntervalRef.current)
  }, [playing, trace, playSpeed])

  const step = trace?.[currentStep]
  const prevStep = trace?.[currentStep - 1]
  const highlightLine = step?.line_idx ?? null

  // Build the live call stack by scanning trace history for calls/returns.
  // main is always the base (emulator starts there without a bl instruction).
  const callStack = useMemo(() => {
    if (!trace || !result?.stack_frames) return []
    const funcNames = new Set(result.stack_frames.map(f => f.function))
    const stack = ['main']
    for (let i = 0; i < currentStep && i < trace.length; i++) {
      const instr = trace[i].instruction.trim()
      const lower = instr.toLowerCase()
      // ARM64: bl _funcname
      if (lower.startsWith('bl ')) {
        const name = instr.slice(3).trim().replace(/^_/, '')
        if (funcNames.has(name) && name !== 'main') stack.push(name)
      }
      // x86_64: callq 0x... <_funcname>
      else if (lower.startsWith('callq ') || lower.startsWith('call ')) {
        const m = instr.match(/<_?(\w+)>/)
        if (m && funcNames.has(m[1]) && m[1] !== 'main') stack.push(m[1])
      }
      // Returns pop the most recent frame (never pop main)
      else if (lower === 'ret' || lower === 'retq') {
        if (stack.length > 1) stack.pop()
      }
    }
    return stack
  }, [trace, currentStep, result])

  // Only enter trace mode once the user starts stepping
  const activeDisassembly = trace && (currentStep > 0 || playing) ? disassembly : null

  // C source line sync — 1-indexed line from atos
  const sourceLine = step?.source_line ?? null

  // Instruction explanation
  const varMap = buildVarMap(result?.segments)
  const explanation = step
    ? explainInstruction(step.instruction, step, varMap, arch)
    : null

  return (
    <div className="app">
      <header className="header">
        <h1>stackframe — C memory visualiser</h1>
        <div className="header-right">
          <div className="arch-selector">
            {ARCHES.map(a => (
              <button
                key={a.id}
                className={`arch-btn${arch === a.id ? ' active' : ''}`}
                onClick={() => handleArchChange(a.id)}
                title={a.sub}
              >
                {a.label}
                <span className="arch-btn-sub">{a.sub}</span>
              </button>
            ))}
          </div>
          <button
            className="compile-btn"
            onClick={handleCompile}
            disabled={loading}
          >
            {loading ? 'Compiling…' : '▶ Compile'}
          </button>
        </div>
      </header>

      <StepControls
        trace={trace}
        currentStep={currentStep}
        setCurrentStep={setCurrentStep}
        playing={playing}
        setPlaying={setPlaying}
        speed={playSpeed}
        setSpeed={setPlaySpeed}
        traceLoading={traceLoading}
        explanation={explanation}
        arch={arch}
      />

      <main className="panels">
        {/* Col 1: C source editor */}
        <div className="panel col-source">
          <div className="panel-header">
            <span className="dot" style={{ background: 'var(--blue)' }} />
            C Source
            {sourceLine != null && (
              <span className="src-sync-badge">line {sourceLine}</span>
            )}
          </div>
          <div className="panel-body">
            <CodeEditor value={code} onChange={setCode} highlightLine={sourceLine} />
          </div>
        </div>

        {/* Col 2: Assembly — center of attention */}
        <div className="panel col-asm">
          <div className="panel-header">
            <span className="dot" style={{ background: 'var(--green)' }} />
            Assembly
            {trace && !activeDisassembly && (
              <span className="asm-hint-badge">press › to step through trace</span>
            )}
          </div>
          <div className="panel-body" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <AssemblyPanel
              assembly={result?.assembly}
              disassembly={activeDisassembly}
              traceStep={step}
              highlightLine={highlightLine}
              segments={result?.segments}
              arch={arch}
              error={error}
              loading={loading}
            />
          </div>
        </div>

        {/* Col 3: right sidebar — memory + registers + stack */}
        <div className="col-sidebar">
          <div className="panel sidebar-panel sidebar-memory">
            <div className="panel-header">
              <span className="dot" style={{ background: 'var(--yellow)' }} />
              Virtual Memory Map
            </div>
            <div className="panel-body">
              <MemoryMap
                segments={result?.segments}
                loading={loading}
                currentTraceStep={step}
              />
            </div>
          </div>

          <div className="panel sidebar-panel sidebar-regs">
            <div className="panel-header">
              <span className="dot" style={{ background: 'var(--teal)' }} />
              Registers
              {arch === 'x86_64' && (
                <span className="arch-note-badge">ARM64 trace only</span>
              )}
            </div>
            <div className="panel-body">
              <RegisterPanel
                registers={step?.registers}
                prevRegisters={prevStep?.registers}
                arch={arch}
              />
            </div>
          </div>

          <div className="panel sidebar-panel sidebar-stack">
            <div className="panel-header">
              <span className="dot" style={{ background: 'var(--purple)' }} />
              Stack Frames
            </div>
            <div className="panel-body">
              <StackFrame
                stackFrames={result?.stack_frames}
                loading={loading}
                arch={arch}
                callStack={callStack}
                traceStep={step}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
