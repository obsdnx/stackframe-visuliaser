export default function StepControls({
  trace,
  currentStep,
  setCurrentStep,
  playing,
  setPlaying,
  speed,
  setSpeed,
  traceLoading,
  explanation,
}) {
  const total = trace ? trace.length : 0

  const reset = () => {
    setPlaying(false)
    setCurrentStep(0)
  }

  const stepBack = () => {
    setPlaying(false)
    setCurrentStep(s => Math.max(0, s - 1))
  }

  const stepForward = () => {
    setPlaying(false)
    setCurrentStep(s => Math.min(total - 1, s + 1))
  }

  const togglePlay = () => {
    if (!trace || total === 0) return
    setPlaying(p => !p)
  }

  const statusText = traceLoading
    ? 'Loading trace…'
    : total > 0
      ? `Step ${currentStep + 1} / ${total}`
      : 'Ready'

  return (
    <div className="step-controls-wrap">
      <div className="step-controls">
        <button className="step-btn" onClick={reset} disabled={traceLoading || total === 0} title="Reset to start">⏮</button>
        <button className="step-btn" onClick={stepBack} disabled={traceLoading || total === 0 || currentStep === 0} title="Step back">‹</button>
        <button className="step-btn" onClick={stepForward} disabled={traceLoading || total === 0 || currentStep >= total - 1} title="Step forward">›</button>
        <button
          className={`step-btn play-btn ${playing ? 'active' : ''}`}
          onClick={togglePlay}
          disabled={traceLoading || total === 0}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>

        <div className="step-speed">
          <label className="step-speed-label">Speed</label>
          <input
            type="range" min={50} max={800} step={50}
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
            className="step-speed-slider"
            title={`${speed}ms per step`}
          />
          <span className="step-speed-val">{speed}ms</span>
        </div>

        <div className="step-status">
          {traceLoading && <span className="step-spinner" />}
          {statusText}
        </div>
      </div>

      {explanation && (
        <div className="step-explanation">
          <span className="step-explanation-label">▸</span>
          {explanation}
        </div>
      )}
    </div>
  )
}
