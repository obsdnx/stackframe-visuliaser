export function buildVarMap(segments) {
  const map = {}
  if (!segments?.stack) return map
  for (const frame of segments.stack) {
    for (const v of frame.vars) {
      if (v.sp_offset != null) {
        map[v.sp_offset] = { name: v.name, type: v.type, fn: frame.function }
      }
    }
  }
  return map
}

function parseHexImm(s) {
  if (!s) return null
  const neg = s.includes('#-')
  const m = s.match(/#-?(?:0x)?([0-9a-fA-F]+)/)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return neg ? -v : v
}

// ── ARM64 explanations ─────────────────────────────────────────────────────

function explainARM64(raw, step, varMap) {
  const op = raw.split(/[\s\t]+/)[0].toLowerCase()
  const rest = raw.slice(op.length).trim()
  const writes = step?.mem_writes || []
  const regs = step?.registers || {}

  const regDec = (name) => {
    const v = regs[name]
    return v != null ? parseInt(v, 16) : null
  }

  switch (op) {
    case 'sub':
      if (rest.match(/^sp,\s*sp/)) {
        const n = Math.abs(parseHexImm(rest) ?? 0)
        return `Allocate ${n} bytes on the stack — reserve space for local variables`
      }
      return 'Subtract two values and store result in register'

    case 'add':
      if (rest.match(/^sp,\s*sp/)) {
        const n = parseHexImm(rest) ?? 0
        return `Deallocate ${n} bytes — shrink stack frame back (function cleanup)`
      }
      if (rest.includes('x29') && rest.includes('sp')) {
        return 'Set frame pointer (fp/x29) — marks the base of this stack frame'
      }
      return 'Add two values and store result in register'

    case 'mul':
      return 'Multiply two registers and store product in destination register'

    case 'stp':
      if (rest.includes('x29') && rest.includes('x30'))
        return 'Save frame pointer (fp) + link register (lr) to stack — function prologue'
      return 'Store pair of registers to memory'

    case 'ldp':
      if (rest.includes('x29') && rest.includes('x30'))
        return 'Restore frame pointer (fp) + link register (lr) — preparing to return'
      return 'Load pair of registers from memory'

    case 'str':
    case 'stur': {
      if (rest.includes('wzr') || rest.includes('xzr'))
        return 'Zero-initialize a local variable (store 0 to stack)'
      const w = writes[0]
      if (w) {
        const v = varMap?.[w.sp_offset]
        if (v) return `Write ${w.value} → ${v.type} ${v.name} at stack sp+${w.sp_offset}`
        return `Write ${w.value} to stack at sp+${w.sp_offset}`
      }
      return 'Store register value to stack memory'
    }

    case 'ldr':
    case 'ldur': {
      const m = rest.match(/\[sp,\s*#(?:0x)?([0-9a-fA-F]+)\]/i)
      if (m) {
        const offset = parseInt(m[1], 16)
        const v = varMap?.[offset]
        if (v) return `Load ${v.type} ${v.name} from stack (sp+${offset}) into register`
        return `Load value from stack sp+${offset} into register`
      }
      return 'Load value from memory into register'
    }

    case 'mov':
    case 'movz': {
      const m = rest.match(/#(?:0x)?([0-9a-fA-F]+)/i)
      if (m) {
        const val = parseInt(m[1], 16)
        return `Load constant ${val} (0x${m[1].toLowerCase()}) into register`
      }
      return 'Copy register value into destination register'
    }

    case 'movk':
      return 'Insert 16-bit chunk into register (building a 64-bit constant in stages)'

    case 'bl': {
      const name = rest.replace(/^_/, '')
      if (name === 'malloc') {
        const sz = regDec('x0')
        return `Call malloc(${sz ?? '?'}) — allocate ${sz ?? '?'} bytes on the heap, returns pointer in x0`
      }
      if (name === 'free') return 'Call free() — release heap memory back to the OS'
      if (name === 'printf') return 'Call printf() — write formatted text to stdout'
      return `Call function ${name}() — save return address to lr (x30), then jump`
    }

    case 'ret':
      return 'Return from function — jump to address in lr (x30), resuming the caller'

    case 'cmp':
      return 'Compare two values — set CPU flags (N/Z/C/V) for conditional branches'

    case 'b.eq': return 'Branch if equal (Z flag set)'
    case 'b.ne': return 'Branch if not equal (Z flag clear)'
    case 'b.lt': return 'Branch if less than (N ≠ V)'
    case 'b.le': return 'Branch if less than or equal'
    case 'b.gt': return 'Branch if greater than'
    case 'b.ge': return 'Branch if greater than or equal'
    case 'b':    return 'Unconditional branch (jump)'

    case 'fmov':  return 'Move floating-point constant into register'
    case 'adrp':  return 'Load page address of a global symbol (for accessing globals/strings)'
    case 'adr':   return 'Load address of a label into register'
    case 'strb':  return 'Store 1 byte to memory'
    case 'ldrb':  return 'Load 1 byte from memory into register (zero-extended)'

    default:
      return raw
  }
}

// ── x86_64 AT&T-syntax explanations ───────────────────────────────────────

function explainX86(raw) {
  const op = raw.split(/[\s\t]+/)[0].toLowerCase()
  const rest = raw.slice(op.length).trim()

  const immVal = () => {
    const m = rest.match(/\$(?:0x)?([0-9a-fA-F]+)/)
    if (!m) return null
    return parseInt(m[1], 16)
  }

  switch (op) {
    case 'pushq':
      if (rest === '%rbp') return "Save caller's frame pointer (rbp) to stack — function prologue"
      return `Push ${rest} onto stack (rsp moves down 8 bytes)`

    case 'popq':
      if (rest === '%rbp') return "Restore caller's frame pointer (rbp) from stack"
      return `Pop top of stack into ${rest}`

    case 'movq':
      if (rest.includes('%rsp') && rest.includes('%rbp'))
        return 'Set frame pointer (rbp = rsp) — marks the base of this stack frame'
      if (rest.startsWith('$')) {
        const v = immVal()
        return `Load 64-bit constant ${v != null ? v : rest} into register`
      }
      if (rest.match(/-\d+\(%rbp\)/))
        return 'Store 64-bit value to local variable on stack (rbp-relative)'
      if (rest.match(/%\w+,\s*%\w+/))
        return 'Copy 64-bit register value into destination register'
      return 'Move 64-bit value'

    case 'movl':
      if (rest.startsWith('$')) {
        const v = immVal()
        return `Load 32-bit constant ${v != null ? v : rest} into register`
      }
      if (rest.match(/-\d+\(%rbp\)/))
        return 'Store 32-bit value to local variable on stack (rbp-relative)'
      return 'Move 32-bit value'

    case 'movb': return 'Move 1-byte value'
    case 'movw': return 'Move 16-bit value'

    case 'subq':
      if (rest.includes('%rsp')) {
        const m = rest.match(/\$(\d+)/)
        const n = m ? parseInt(m[1]) : '?'
        return `Allocate ${n} bytes on the stack — reserve space for local variables`
      }
      return 'Subtract 64-bit values'

    case 'subl': return 'Subtract 32-bit values'

    case 'addq':
      if (rest.includes('%rsp')) {
        const m = rest.match(/\$(\d+)/)
        const n = m ? parseInt(m[1]) : '?'
        return `Deallocate ${n} bytes — restore stack pointer (function cleanup)`
      }
      return 'Add 64-bit values'

    case 'addl': return 'Add 32-bit values'

    case 'imull':
    case 'imulq': return 'Signed multiply and store product in destination'

    case 'leaq': return 'Load effective address — compute address of memory operand without reading it'

    case 'callq':
    case 'call': {
      const name = rest.replace(/^_/, '').replace(/^<(.+)>$/, '$1')
      if (name.includes('malloc')) return 'Call malloc() — allocate heap memory, returns pointer in rax'
      if (name.includes('free')) return 'Call free() — release heap memory back to the OS'
      if (name.includes('printf')) return 'Call printf() — write formatted text to stdout'
      return `Call function ${name}() — push return address to stack, then jump`
    }

    case 'retq':
    case 'ret': return 'Return from function — pop return address from stack, jump to caller'

    case 'cmpq':
    case 'cmpl':
    case 'cmpb': return 'Compare two values — set CPU flags (ZF/SF/OF/CF) for conditional jumps'

    case 'je':   case 'jz':   return 'Jump if equal / zero (ZF set)'
    case 'jne':  case 'jnz':  return 'Jump if not equal / not zero (ZF clear)'
    case 'jl':   case 'jnge': return 'Jump if less than (signed)'
    case 'jle':  case 'jng':  return 'Jump if less than or equal (signed)'
    case 'jg':   case 'jnle': return 'Jump if greater than (signed)'
    case 'jge':  case 'jnl':  return 'Jump if greater than or equal (signed)'
    case 'jmp':  return 'Unconditional jump'

    case 'xorl':
    case 'xorq':
      if (rest.match(/^%(\w+),\s*%\1$/)) return 'Zero out register (XOR with itself — faster than mov $0)'
      return 'Bitwise XOR'

    case 'andl': case 'andq': return 'Bitwise AND'
    case 'orl':  case 'orq':  return 'Bitwise OR'
    case 'notl': case 'notq': return "Bitwise NOT (one's complement)"
    case 'negl': case 'negq': return 'Negate (two\'s complement / multiply by -1)'
    case 'sarl': case 'sarq': return 'Arithmetic right shift (sign-extending)'
    case 'shrl': case 'shrq': return 'Logical right shift (zero-filling)'
    case 'shll': case 'shlq': return 'Left shift'
    case 'nop': return 'No operation — padding for alignment'

    default: return raw
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function explainInstruction(instr, step, varMap, arch = 'arm64') {
  if (!instr) return ''
  const raw = instr.trim()
  if (arch === 'x86_64') return explainX86(raw)
  return explainARM64(raw, step, varMap)
}
