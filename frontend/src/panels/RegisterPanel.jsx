import { useEffect, useRef, useState } from 'react'

function RegCell({ name, label, value, changed }) {
  const [flash, setFlash] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    if (changed && value != null) {
      setFlash(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setFlash(false), 500)
    }
    return () => clearTimeout(timer.current)
  }, [changed, value])

  return (
    <div className={`reg-cell${flash ? ' reg-changed' : ''}`}>
      <span className="reg-name">{label || name}</span>
      <span className="reg-value">{value ?? '0x0'}</span>
    </div>
  )
}

const ARM64_GROUPS = [
  {
    label: 'args / return',
    regs: [
      { key: 'x0' }, { key: 'x1' }, { key: 'x2' }, { key: 'x3' },
      { key: 'x4' }, { key: 'x5' }, { key: 'x6' }, { key: 'x7' },
    ],
  },
  {
    label: 'special',
    regs: [
      { key: 'sp', label: 'sp' },
      { key: 'fp', label: 'fp/x29' },
      { key: 'lr', label: 'lr/x30' },
      { key: 'pc', label: 'pc' },
    ],
  },
]

const X86_GROUPS = [
  {
    label: 'general purpose',
    regs: [
      { key: 'rax', label: 'rax' },
      { key: 'rbx', label: 'rbx' },
      { key: 'rcx', label: 'rcx' },
      { key: 'rdx', label: 'rdx' },
      { key: 'rdi', label: 'rdi (arg1)' },
      { key: 'rsi', label: 'rsi (arg2)' },
      { key: 'r8',  label: 'r8' },
      { key: 'r9',  label: 'r9' },
    ],
  },
  {
    label: 'special',
    regs: [
      { key: 'rsp', label: 'rsp (stack)' },
      { key: 'rbp', label: 'rbp (frame)' },
      { key: 'rip', label: 'rip (pc)' },
    ],
  },
]

export default function RegisterPanel({ registers, prevRegisters, arch = 'arm64' }) {
  if (!registers) {
    return (
      <div className="register-panel-empty">
        No register data — start trace to see registers
      </div>
    )
  }

  const prev = prevRegisters || {}
  const groups = arch === 'x86_64' ? X86_GROUPS : ARM64_GROUPS

  return (
    <div className="register-panel">
      {groups.map(group => (
        <div key={group.label}>
          <div className="reg-group-label">{group.label}</div>
          <div className="reg-grid">
            {group.regs.map(({ key, label }) => (
              <RegCell
                key={key}
                name={key}
                label={label}
                value={registers[key]}
                changed={registers[key] !== prev[key]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
