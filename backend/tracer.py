"""
ARM64 + x86_64 emulator + trace generator for educational C memory visualisation.
Approximate — designed for simple C programs with no syscalls.
"""

import re
import subprocess
import os


# ---------------------------------------------------------------------------
# 1. otool disassembly
# ---------------------------------------------------------------------------

def get_otool_disassembly(binary_path, arch='arm64'):
    result = subprocess.run(
        ['otool', '-tv', '-arch', arch, binary_path],
        capture_output=True, text=True, timeout=15
    )
    return result.stdout


# ---------------------------------------------------------------------------
# 2. Source line mapping via atos
# ---------------------------------------------------------------------------

def get_source_lines(binary_path, addresses, arch='arm64'):
    if not addresses:
        return {}
    try:
        addr_args = [hex(a) for a in addresses]
        result = subprocess.run(
            ['atos', '-o', binary_path, '-arch', arch, '-l', '0x100000000'] + addr_args,
            capture_output=True, text=True, timeout=15
        )
        addr_to_line = {}
        for addr, info in zip(addresses, result.stdout.strip().split('\n')):
            m = re.search(r':(\d+)\)', info)
            if m:
                addr_to_line[addr] = int(m.group(1))
        return addr_to_line
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# 3. Parse otool output (works for both ARM64 and x86_64)
# ---------------------------------------------------------------------------

def parse_otool(disasm_text):
    instructions = []
    addr_map = {}
    func_map = {}

    for raw_idx, raw in enumerate(disasm_text.split('\n')):
        line = raw.strip()
        if not line:
            continue

        m = re.match(r'^_?([a-zA-Z_]\w*):$', line)
        if m:
            func_map['__pending__'] = m.group(1)
            continue

        m = re.match(r'^([0-9a-fA-F]+)\s+(.+)$', line)
        if m:
            addr = int(m.group(1), 16)
            instr = m.group(2).strip()
            if '__pending__' in func_map:
                fname = func_map.pop('__pending__')
                func_map[fname] = addr
            # raw_idx = actual line position in the split text so that
            # line_idx maps directly to disassembly.split('\n')[line_idx]
            instructions.append((addr, instr, raw_idx))
            addr_map[addr] = raw_idx

    return instructions, addr_map, func_map


# ---------------------------------------------------------------------------
# 4. ARM64 emulator
# ---------------------------------------------------------------------------

class ARM64Emulator:
    HEAP_BASE = 0x100000000

    def __init__(self, func_map=None):
        self.regs = {f'x{i}': 0 for i in range(29)}
        self.regs.update({'x29': 0, 'x30': 0, 'sp': 0, 'pc': 0})
        self.mem = {}
        self.heap_bump = self.HEAP_BASE
        self.func_map = func_map or {}

    def r(self, name):
        name = name.strip()
        if name == 'fp': return self.regs['x29']
        if name == 'lr': return self.regs['x30']
        m = re.match(r'^w(\d+)$', name)
        if m:
            return self.regs.get(f'x{m.group(1)}', 0) & 0xFFFFFFFF
        return self.regs.get(name, 0)

    def w(self, name, val):
        name = name.strip()
        val = int(val) & 0xFFFFFFFFFFFFFFFF
        if name == 'fp':   self.regs['x29'] = val; return
        if name == 'lr':   self.regs['x30'] = val; return
        m = re.match(r'^w(\d+)$', name)
        if m:
            self.regs[f'x{m.group(1)}'] = val & 0xFFFFFFFF
            return
        self.regs[name] = val

    def imm(self, s):
        s = s.strip()
        if not s.startswith('#'): raise ValueError(f'Not an immediate: {s}')
        s = s[1:]
        neg = s.startswith('-')
        if neg: s = s[1:]
        v = int(s, 16) if s.startswith('0x') or s.startswith('0X') else int(s)
        return -v if neg else v

    def mem_addr(self, expr):
        expr = expr.strip()
        m = re.match(r'\[(\w+),\s*#(-?\d+|0x[0-9a-fA-F]+)\]', expr)
        if m:
            base = self.r(m.group(1))
            off = m.group(2)
            if off.startswith('-'):
                offset = -int(off[1:], 16 if 'x' in off else 10)
            elif off.startswith('0x'):
                offset = int(off, 16)
            else:
                offset = int(off)
            return (base + offset) & 0xFFFFFFFFFFFFFFFF
        m = re.match(r'\[(\w+)\]', expr)
        if m: return self.r(m.group(1))
        raise ValueError(f'Cannot parse: {expr}')

    def mem_write(self, addr, size, value):
        value = int(value) & ((1 << (size * 8)) - 1)
        for i in range(size):
            self.mem[addr + i] = (value >> (8 * i)) & 0xFF

    def mem_read(self, addr, size):
        val = 0
        for i in range(size):
            val |= self.mem.get(addr + i, 0) << (8 * i)
        return val

    def execute(self, instr_str):
        mem_writes = []
        parts = re.split(r'[\s,]+', instr_str.strip(), maxsplit=1)
        op = parts[0].lower()
        args = _split_args(parts[1] if len(parts) > 1 else '')

        try:
            if op == 'sub':
                self.w(args[0], self.r(args[1]) - self.imm(args[2]))
            elif op == 'add':
                src2 = self.imm(args[2]) if args[2].startswith('#') else self.r(args[2])
                self.w(args[0], self.r(args[1]) + src2)
            elif op == 'mul':
                self.w(args[0], self.r(args[1]) * self.r(args[2]))
            elif op in ('mov', 'movz'):
                src = self.imm(args[1]) if args[1].startswith('#') else self.r(args[1])
                self.w(args[0], src)
            elif op == 'movk':
                dst, imm_v = args[0], self.imm(args[1])
                shift = 0
                if len(args) > 2:
                    sm = re.search(r'#(\d+)', args[2])
                    if sm: shift = int(sm.group(1))
                mask = ~(0xFFFF << shift) & 0xFFFFFFFFFFFFFFFF
                self.w(dst, (self.r(dst) & mask) | ((imm_v & 0xFFFF) << shift))
            elif op in ('str', 'stur'):
                src = args[0]; addr = self.mem_addr(args[1])
                size = 4 if src.startswith('w') else 8
                val = self.r(src)
                self.mem_write(addr, size, val)
                mem_writes.append({'addr': addr, 'size': size, 'value': val,
                                   'sp_offset': addr - self.r('sp')})
            elif op == 'strb':
                src = args[0]; addr = self.mem_addr(args[1])
                val = self.r(src) & 0xFF
                self.mem_write(addr, 1, val)
                mem_writes.append({'addr': addr, 'size': 1, 'value': val,
                                   'sp_offset': addr - self.r('sp')})
            elif op == 'stp':
                r1, r2, addr_expr = args[0], args[1], args[2]
                pre = addr_expr.endswith('!')
                if pre: addr_expr = addr_expr[:-1]
                addr = self.mem_addr(addr_expr)
                if pre: self.w('sp', addr)
                size = 4 if r1.startswith('w') else 8
                v1, v2 = self.r(r1), self.r(r2)
                self.mem_write(addr, size, v1)
                self.mem_write(addr + size, size, v2)
                mem_writes.append({'addr': addr, 'size': size, 'value': v1,
                                   'sp_offset': addr - self.r('sp')})
                mem_writes.append({'addr': addr + size, 'size': size, 'value': v2,
                                   'sp_offset': addr + size - self.r('sp')})
            elif op in ('ldr', 'ldur'):
                dst = args[0]; addr = self.mem_addr(args[1])
                size = 4 if dst.startswith('w') else 8
                self.w(dst, self.mem_read(addr, size))
            elif op == 'ldrb':
                self.w(args[0], self.mem_read(self.mem_addr(args[1]), 1))
            elif op == 'ldp':
                r1, r2 = args[0], args[1]; addr = self.mem_addr(args[2])
                size = 4 if r1.startswith('w') else 8
                self.w(r1, self.mem_read(addr, size))
                self.w(r2, self.mem_read(addr + size, size))
            elif op == 'cmp':
                pass
            elif op in ('fmov', 'adrp', 'adr'):
                pass
            elif op == 'bl':
                target = args[0] if args else ''
                self.w('x30', self.r('pc') + 4)
                if '_malloc' in target or target == '_malloc':
                    sz = self.r('x0')
                    heap_addr = self.heap_bump
                    self.heap_bump += max(sz, 8)
                    self.w('x0', heap_addr)
                else:
                    fname = target.lstrip('_')
                    if fname in self.func_map:
                        self.w('pc', self.func_map[fname])
                        return mem_writes
            elif op == 'ret':
                self.w('pc', self.r('x30'))
                return mem_writes
        except (IndexError, ValueError, KeyError):
            pass

        self.w('pc', self.r('pc') + 4)
        return mem_writes

    def snapshot_registers(self):
        return {k: hex(self.r(k)) for k in
                ['x0','x1','x2','x3','x4','x5','x6','x7','sp','fp','lr','pc']}


# ---------------------------------------------------------------------------
# 5. x86_64 emulator (AT&T syntax)
# ---------------------------------------------------------------------------

# Canonical 64-bit register name for aliased names
_X86_ALIAS = {}
for _n in 'abcd':
    _X86_ALIAS.update({f'e{_n}x': f'r{_n}x', f'{_n}x': f'r{_n}x',
                       f'{_n}l': f'r{_n}x', f'{_n}h': f'r{_n}x'})
for _n in ('si', 'di', 'sp', 'bp'):
    _X86_ALIAS.update({f'e{_n}': f'r{_n}', _n: f'r{_n}'})
for _i in range(8, 16):
    _X86_ALIAS.update({f'r{_i}d': f'r{_i}', f'r{_i}w': f'r{_i}', f'r{_i}b': f'r{_i}'})


class X86_64Emulator:
    HEAP_BASE = 0x200000000

    def __init__(self, func_map=None):
        self.regs = {f'r{n}x': 0 for n in 'abcd'}
        self.regs.update({'rsi': 0, 'rdi': 0, 'rsp': 0, 'rbp': 0, 'rip': 0})
        self.regs.update({f'r{i}': 0 for i in range(8, 16)})
        self.flags = {'zf': 0, 'sf': 0, 'of': 0, 'cf': 0}
        self.mem = {}
        self.heap_bump = self.HEAP_BASE
        self.func_map = func_map or {}

    def _canon(self, name):
        name = name.strip().lstrip('%')
        return _X86_ALIAS.get(name, name)

    def r(self, name):
        name = name.strip().lstrip('%')
        canon = _X86_ALIAS.get(name, name)
        val = self.regs.get(canon, 0)
        if name.startswith('e') or name.endswith('d'): return val & 0xFFFFFFFF
        if name in ('ax','bx','cx','dx','si','di','sp','bp') or name.endswith('w'):
            return val & 0xFFFF
        if name.endswith(('l','h','b')): return val & 0xFF
        return val

    def w(self, name, val):
        name = name.strip().lstrip('%')
        canon = _X86_ALIAS.get(name, name)
        val = int(val) & 0xFFFFFFFFFFFFFFFF
        # 32-bit writes zero-extend to 64-bit in x86_64
        if name.startswith('e') or (name.endswith('d') and name not in ('rbp','rsp','rbx','rax','rcx','rdx')):
            self.regs[canon] = val & 0xFFFFFFFF
        else:
            self.regs[canon] = val

    def mem_write(self, addr, size, value):
        value = int(value) & ((1 << (size * 8)) - 1)
        for i in range(size):
            self.mem[addr + i] = (value >> (8 * i)) & 0xFF

    def mem_read(self, addr, size):
        val = 0
        for i in range(size):
            val |= self.mem.get(addr + i, 0) << (8 * i)
        return val

    def _mem_addr(self, expr):
        """Parse AT&T memory operand: -0x8(%rbp), (%rsp), 0x10(%rsp)."""
        expr = expr.strip()
        m = re.match(r'^(-?(?:0x[0-9a-fA-F]+|\d+))?\((%?\w+)\)$', expr)
        if not m: return None
        off_s = m.group(1) or '0'
        reg = m.group(2).lstrip('%')
        canon = _X86_ALIAS.get(reg, reg)
        if off_s.startswith('-0x'):   offset = -int(off_s[3:], 16)
        elif off_s.startswith('-'):   offset = -int(off_s[1:])
        elif off_s.startswith('0x'):  offset = int(off_s[2:], 16)
        else:                         offset = int(off_s)
        return (self.regs.get(canon, 0) + offset) & 0xFFFFFFFFFFFFFFFF

    def _imm(self, expr):
        """Parse AT&T immediate: $10, $0xa, $-4."""
        expr = expr.strip()
        if not expr.startswith('$'): return None
        s = expr[1:]
        if s.startswith('-0x'): return -int(s[3:], 16)
        if s.startswith('-'):   return -int(s[1:])
        if s.startswith('0x'): return int(s[2:], 16)
        return int(s)

    def _src_val(self, operand, size=8):
        """Evaluate a source operand (register, immediate, or memory)."""
        operand = operand.strip()
        if operand.startswith('$'):
            return self._imm(operand) or 0
        if operand.startswith('%'):
            return self.r(operand)
        addr = self._mem_addr(operand)
        if addr is not None:
            return self.mem_read(addr, size)
        return 0

    def _set_flags(self, result, bits=64):
        mask = (1 << bits) - 1
        self.flags['zf'] = 1 if (result & mask) == 0 else 0
        self.flags['sf'] = 1 if (result >> (bits - 1)) & 1 else 0

    def _op_size(self, op):
        if op.endswith('q'): return 8
        if op.endswith('l'): return 4
        if op.endswith('w'): return 2
        if op.endswith('b'): return 1
        return 8

    def execute(self, instr_str):
        """
        Execute one x86_64 AT&T instruction.
        Returns (mem_writes, jumped) — jumped=True if RIP was changed by a branch.
        call/ret are NOT handled here; the main loop manages them.
        """
        mem_writes = []
        parts = re.split(r'\s+', instr_str.strip(), maxsplit=1)
        op = parts[0].lower()
        args = _split_x86_args(parts[1] if len(parts) > 1 else '')
        size = self._op_size(op)
        jumped = False

        try:
            if op == 'pushq':
                val = self._src_val(args[0])
                rsp = (self.regs['rsp'] - 8) & 0xFFFFFFFFFFFFFFFF
                self.regs['rsp'] = rsp
                self.mem_write(rsp, 8, val)
                rbp_off = rsp - self.regs.get('rbp', 0)
                mem_writes.append({'addr': rsp, 'size': 8, 'value': val, 'sp_offset': rbp_off})

            elif op == 'popq':
                rsp = self.regs['rsp']
                val = self.mem_read(rsp, 8)
                self.w(args[0], val)
                self.regs['rsp'] = (rsp + 8) & 0xFFFFFFFFFFFFFFFF

            elif op in ('movq','movl','movw','movb','movslq','movzbl','movzwl','cltq','cqto'):
                if op in ('cltq', 'cqto'):
                    pass  # sign-extend eax→rax or rax→rdx:rax, approximate no-op
                else:
                    src, dst = args[0], args[1]
                    val = self._src_val(src, size)
                    if dst.startswith('%'):
                        self.w(dst, val)
                    else:
                        addr = self._mem_addr(dst)
                        if addr is not None:
                            self.mem_write(addr, size, val)
                            rbp_off = addr - self.regs.get('rbp', 0)
                            mem_writes.append({'addr': addr, 'size': size,
                                               'value': val, 'sp_offset': rbp_off})

            elif op in ('subq','subl','subw','subb'):
                src, dst = args[0], args[1]
                sv = self._src_val(src, size)
                if dst.startswith('%'):
                    dv = self.r(dst)
                    result = (dv - sv) & 0xFFFFFFFFFFFFFFFF
                    self.w(dst, result)
                    self._set_flags(result, size * 8)
                else:
                    addr = self._mem_addr(dst)
                    if addr:
                        dv = self.mem_read(addr, size)
                        result = (dv - sv) & ((1 << (size * 8)) - 1)
                        self.mem_write(addr, size, result)
                        self._set_flags(result, size * 8)
                        rbp_off = addr - self.regs.get('rbp', 0)
                        mem_writes.append({'addr': addr, 'size': size,
                                           'value': result, 'sp_offset': rbp_off})

            elif op in ('addq','addl','addw','addb'):
                src, dst = args[0], args[1]
                sv = self._src_val(src, size)
                if dst.startswith('%'):
                    dv = self.r(dst)
                    result = (dv + sv) & 0xFFFFFFFFFFFFFFFF
                    self.w(dst, result)
                    self._set_flags(result, size * 8)
                else:
                    addr = self._mem_addr(dst)
                    if addr:
                        dv = self.mem_read(addr, size)
                        result = (dv + sv) & ((1 << (size * 8)) - 1)
                        self.mem_write(addr, size, result)
                        self._set_flags(result, size * 8)
                        rbp_off = addr - self.regs.get('rbp', 0)
                        mem_writes.append({'addr': addr, 'size': size,
                                           'value': result, 'sp_offset': rbp_off})

            elif op in ('imulq','imull','imulw'):
                if len(args) == 2:
                    sv = self._src_val(args[0], size)
                    dv = self.r(args[1])
                    self.w(args[1], sv * dv)
                elif len(args) == 3:
                    sv = self._src_val(args[0], size)
                    s2 = self._src_val(args[1], size)
                    self.w(args[2], sv * s2)
                else:
                    sv = self._src_val(args[0], size)
                    self.regs['rax'] = (self.regs['rax'] * sv) & 0xFFFFFFFFFFFFFFFF

            elif op in ('idivl','idivq'):
                sv = self._src_val(args[0], size)
                if sv:
                    self.regs['rax'] = (self.regs['rax'] // sv) & 0xFFFFFFFFFFFFFFFF
                    self.regs['rdx'] = (self.regs['rax'] % sv) & 0xFFFFFFFFFFFFFFFF

            elif op in ('cmpq','cmpl','cmpw','cmpb'):
                src, dst = args[0], args[1]
                sv = self._src_val(src, size)
                dv = self._src_val(dst, size)
                result = dv - sv
                self._set_flags(result, size * 8)
                self.flags['cf'] = 1 if dv < sv else 0

            elif op in ('testq','testl','testb','testw'):
                sv = self._src_val(args[0], size)
                dv = self._src_val(args[1], size)
                self._set_flags(sv & dv, size * 8)

            elif op in ('leaq','leal'):
                addr = self._mem_addr(args[0])
                if addr is not None:
                    self.w(args[1], addr)

            elif op in ('xorq','xorl','xorw','xorb'):
                sv = self._src_val(args[0], size)
                dv = self.r(args[1])
                result = sv ^ dv
                self.w(args[1], result)
                self._set_flags(result, size * 8)

            elif op in ('andq','andl','andw','andb'):
                sv = self._src_val(args[0], size)
                self.w(args[1], self.r(args[1]) & sv)

            elif op in ('orq','orl','orw','orb'):
                sv = self._src_val(args[0], size)
                self.w(args[1], self.r(args[1]) | sv)

            elif op in ('negq','negl'):
                self.w(args[0], (-self.r(args[0])) & 0xFFFFFFFFFFFFFFFF)

            elif op in ('notq','notl'):
                self.w(args[0], (~self.r(args[0])) & 0xFFFFFFFFFFFFFFFF)

            elif op in ('sarq','sarl','shlq','shll','shrq','shrl'):
                count = self._src_val(args[0], 1) & 0x3F if len(args) > 1 else 1
                dst_val = self.r(args[-1])
                if 'sar' in op:
                    bits = size * 8
                    signed = dst_val if dst_val < (1 << (bits-1)) else dst_val - (1 << bits)
                    result = signed >> count
                elif 'shr' in op:
                    result = dst_val >> count
                else:
                    result = dst_val << count
                self.w(args[-1], result & 0xFFFFFFFFFFFFFFFF)

            elif op == 'incq' or op == 'incl':
                self.w(args[0], (self.r(args[0]) + 1) & 0xFFFFFFFFFFFFFFFF)

            elif op == 'decq' or op == 'decl':
                self.w(args[0], (self.r(args[0]) - 1) & 0xFFFFFFFFFFFFFFFF)

            # Conditional branches — change RIP if condition met
            elif op == 'jmp':
                target = _parse_x86_jump_target(args[0] if args else '')
                if target is not None:
                    self.regs['rip'] = target
                    jumped = True

            elif op in ('je','jz'):
                if self.flags['zf']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jne','jnz'):
                if not self.flags['zf']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jl','jnge'):
                if self.flags['sf'] != self.flags['of']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jle','jng'):
                if self.flags['zf'] or self.flags['sf'] != self.flags['of']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jg','jnle'):
                if not self.flags['zf'] and self.flags['sf'] == self.flags['of']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jge','jnl'):
                if self.flags['sf'] == self.flags['of']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('ja','jnbe'):
                if not self.flags['cf'] and not self.flags['zf']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            elif op in ('jb','jnae','jc'):
                if self.flags['cf']:
                    t = _parse_x86_jump_target(args[0] if args else '')
                    if t: self.regs['rip'] = t; jumped = True

            # No-ops
            elif op in ('nop','nopl','nopw','ud2','endbr64'):
                pass

        except (IndexError, ValueError, KeyError, TypeError, ZeroDivisionError):
            pass

        return mem_writes, jumped

    def snapshot_registers(self):
        return {
            'rax': hex(self.regs.get('rax', 0)),
            'rbx': hex(self.regs.get('rbx', 0)),
            'rcx': hex(self.regs.get('rcx', 0)),
            'rdx': hex(self.regs.get('rdx', 0)),
            'rdi': hex(self.regs.get('rdi', 0)),
            'rsi': hex(self.regs.get('rsi', 0)),
            'r8':  hex(self.regs.get('r8',  0)),
            'r9':  hex(self.regs.get('r9',  0)),
            'rsp': hex(self.regs.get('rsp', 0)),
            'rbp': hex(self.regs.get('rbp', 0)),
            'rip': hex(self.regs.get('rip', 0)),
        }


def _parse_x86_jump_target(operand):
    operand = operand.strip()
    try:
        if operand.startswith('0x'): return int(operand, 16)
        if re.match(r'^\d+$', operand): return int(operand)
    except ValueError:
        pass
    return None


# ---------------------------------------------------------------------------
# 6. Shared arg-splitting helpers
# ---------------------------------------------------------------------------

def _split_args(args_str):
    """Split ARM64 comma-separated args, preserving bracket expressions."""
    args, depth, current = [], 0, ''
    for ch in args_str:
        if ch == '[':   depth += 1; current += ch
        elif ch == ']': depth -= 1; current += ch
        elif ch == ',' and depth == 0:
            args.append(current.strip()); current = ''
        else:
            current += ch
    if current.strip(): args.append(current.strip())
    return args


def _split_x86_args(args_str):
    """Split x86_64 AT&T args by comma, preserving parenthesized memory operands."""
    args, depth, current = [], 0, ''
    for ch in args_str:
        if ch == '(':   depth += 1; current += ch
        elif ch == ')': depth -= 1; current += ch
        elif ch == ',' and depth == 0:
            args.append(current.strip()); current = ''
        else:
            current += ch
    if current.strip(): args.append(current.strip())
    return args


# ---------------------------------------------------------------------------
# 7. generate_trace
# ---------------------------------------------------------------------------

def generate_trace(c_code, arch='arm64', max_steps=600):
    """
    Compile c_code, emulate main(), return (disassembly_text, trace_list, error).
    trace step: {step, pc, line_idx, instruction, registers, mem_writes, source_line}
    """
    src_path = '/tmp/prog_src.c'
    bin_path = '/tmp/prog_trace'

    try:
        with open(src_path, 'w') as f:
            f.write(c_code)

        # Compile
        gcc_arch = ['-arch', arch]
        result = subprocess.run(
            ['gcc', '-g', '-O0'] + gcc_arch + ['-o', bin_path, src_path],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            return None, [], result.stderr or 'Compilation failed'

        # Disassemble
        disasm_text = get_otool_disassembly(bin_path, arch=arch)
        if not disasm_text.strip():
            return None, [], 'otool produced no output'

        instructions, addr_map, func_map = parse_otool(disasm_text)

        if 'main' not in func_map:
            return disasm_text, [], 'No main function found in disassembly'

        main_addr = func_map['main']
        instr_by_addr = {addr: (instr, lidx) for addr, instr, lidx in instructions}

        # next_addr_map — needed for x86_64 variable-length instruction advancement
        next_addr_map = {}
        for i in range(len(instructions) - 1):
            next_addr_map[instructions[i][0]] = instructions[i + 1][0]

        if arch == 'x86_64':
            trace = _trace_x86_64(
                func_map, instr_by_addr, addr_map, next_addr_map, main_addr, max_steps
            )
        else:
            trace = _trace_arm64(
                func_map, instr_by_addr, addr_map, main_addr, max_steps
            )

        # Enrich with C source line numbers via atos
        unique_addrs = list(set(int(s['pc'], 16) for s in trace))
        addr_to_line = get_source_lines(bin_path, unique_addrs, arch=arch)
        for ts in trace:
            ts['source_line'] = addr_to_line.get(int(ts['pc'], 16))

        return disasm_text, trace, None

    except subprocess.TimeoutExpired:
        return None, [], 'Compilation/execution timed out'
    except FileNotFoundError as e:
        return None, [], f'Tool not found: {e}'
    except Exception as e:
        return None, [], f'Trace error: {e}'
    finally:
        for p in (src_path, bin_path):
            try: os.unlink(p)
            except Exception: pass


def _trace_arm64(func_map, instr_by_addr, addr_map, main_addr, max_steps):
    emu = ARM64Emulator(func_map=func_map)
    emu.w('pc', main_addr)
    emu.w('sp', 0x7fff00000000)
    emu.w('x30', 0)
    trace = []
    step = 0

    while step < max_steps:
        pc = emu.r('pc')
        if pc not in instr_by_addr: break
        instr_str, line_idx = instr_by_addr[pc]
        mem_writes = emu.execute(instr_str)
        new_pc = emu.r('pc')
        if pc in addr_map:
            trace.append({
                'step': step, 'pc': hex(pc), 'line_idx': line_idx,
                'instruction': instr_str, 'registers': emu.snapshot_registers(),
                'mem_writes': mem_writes, 'source_line': None,
            })
        if new_pc not in instr_by_addr: break
        if emu.r('x30') == 0 and instr_str.strip().startswith('ret'): break
        step += 1

    return trace


def _trace_x86_64(func_map, instr_by_addr, addr_map, next_addr_map, main_addr, max_steps):
    emu = X86_64Emulator(func_map=func_map)
    emu.regs['rip'] = main_addr
    emu.regs['rsp'] = 0x7fff00000000
    # Push sentinel return address so retq from main terminates the trace
    emu.regs['rsp'] -= 8
    emu.mem_write(emu.regs['rsp'], 8, 0)  # ret to 0 → stop

    trace = []
    step = 0

    while step < max_steps:
        pc = emu.regs['rip']
        if pc not in instr_by_addr: break

        instr_str, line_idx = instr_by_addr[pc]
        op = instr_str.strip().split()[0].lower() if instr_str.strip() else ''
        next_pc = next_addr_map.get(pc)

        # ── call / ret are managed here, not in execute() ──────────────────
        if op in ('callq', 'call'):
            args_str = instr_str.strip()[len(op):].strip()
            target_str = args_str

            # Push return address so retq can pop it
            ret_addr = next_pc or 0
            rsp = (emu.regs['rsp'] - 8) & 0xFFFFFFFFFFFFFFFF
            emu.regs['rsp'] = rsp
            emu.mem_write(rsp, 8, ret_addr)

            # Resolve target
            target_addr = None
            if target_str.startswith('0x'):
                try: target_addr = int(target_str, 16)
                except ValueError: pass
            else:
                fname = target_str.lstrip('_')
                target_addr = func_map.get(fname)

            # Extern call simulation (malloc, free, printf)
            if 'malloc' in target_str:
                sz = emu.regs.get('rdi', 0)
                heap_addr = emu.heap_bump
                emu.heap_bump += max(sz, 8)
                emu.regs['rax'] = heap_addr
                emu.regs['rip'] = ret_addr  # skip into call target, come back immediately
            elif target_addr is not None and target_addr in instr_by_addr:
                emu.regs['rip'] = target_addr  # jump into user function
            else:
                emu.regs['rip'] = ret_addr  # unknown extern: skip it

            if pc in addr_map:
                trace.append({
                    'step': step, 'pc': hex(pc), 'line_idx': line_idx,
                    'instruction': instr_str, 'registers': emu.snapshot_registers(),
                    'mem_writes': [], 'source_line': None,
                })
            step += 1
            continue

        if op in ('retq', 'ret'):
            rsp = emu.regs['rsp']
            ret_addr = emu.mem_read(rsp, 8)
            emu.regs['rsp'] = (rsp + 8) & 0xFFFFFFFFFFFFFFFF
            emu.regs['rip'] = ret_addr

            if pc in addr_map:
                trace.append({
                    'step': step, 'pc': hex(pc), 'line_idx': line_idx,
                    'instruction': instr_str, 'registers': emu.snapshot_registers(),
                    'mem_writes': [], 'source_line': None,
                })

            if ret_addr not in instr_by_addr: break  # returned out of known code
            step += 1
            continue

        # ── All other instructions ──────────────────────────────────────────
        mem_writes, jumped = emu.execute(instr_str)

        if pc in addr_map:
            trace.append({
                'step': step, 'pc': hex(pc), 'line_idx': line_idx,
                'instruction': instr_str, 'registers': emu.snapshot_registers(),
                'mem_writes': mem_writes, 'source_line': None,
            })

        if not jumped:
            # Normal instruction — advance to next sequential address
            if next_pc is None: break
            emu.regs['rip'] = next_pc
        else:
            # Branch taken — rip already set by execute()
            if emu.regs['rip'] not in instr_by_addr: break

        step += 1

    return trace
