import re
import subprocess
import tempfile
import os

TYPE_SIZES = {
    'char': 1,
    'short': 2, 'short int': 2,
    'int': 4,
    'long': 8, 'long int': 8,
    'long long': 8, 'long long int': 8,
    'float': 4,
    'double': 8,
    'long double': 16,
    'void': 0,
    'size_t': 8, 'ssize_t': 8, 'ptrdiff_t': 8,
    'uint8_t': 1, 'int8_t': 1,
    'uint16_t': 2, 'int16_t': 2,
    'uint32_t': 4, 'int32_t': 4,
    'uint64_t': 8, 'int64_t': 8,
}

KEYWORDS = {
    'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'return', 'break', 'continue', 'goto', 'struct', 'union',
    'enum', 'typedef', 'sizeof',
}


def get_type_size(type_str):
    s = type_str.strip()
    if '*' in s:
        return 8
    for q in ['const ', 'volatile ', 'static ', 'extern ', 'register ', 'unsigned ', 'signed ']:
        s = s.replace(q, '')
    s = s.strip()
    return TYPE_SIZES.get(s, 4)


def strip_comments(code):
    code = re.sub(r'//[^\n]*', '', code)
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    return code


def compile_to_assembly(c_code, arch='arm64'):
    with tempfile.NamedTemporaryFile(suffix='.c', mode='w', delete=False, dir='/tmp') as f:
        f.write(c_code)
        tmp_path = f.name

    try:
        cmd = ['gcc', '-S', '-O0', '-fverbose-asm', '-o', '-']
        if arch == 'x86_64':
            cmd += ['-arch', 'x86_64']
        else:
            cmd += ['-arch', 'arm64']
        cmd.append(tmp_path)

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        assembly = result.stdout if result.stdout.strip() else None
        stderr = result.stderr.strip() if result.stderr.strip() else None
        if result.returncode != 0:
            return None, stderr or 'Compilation failed'
        return assembly, stderr
    except subprocess.TimeoutExpired:
        return None, 'Compilation timed out (>15s)'
    except FileNotFoundError:
        return None, 'gcc not found — install Xcode Command Line Tools'
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ── Regex patterns ─────────────────────────────────────────────────────────

VAR_RE = re.compile(
    r'^\s*'
    r'(?:(?:static|extern|const|volatile|register)\s+)*'
    r'((?:unsigned\s+|signed\s+)?'
    r'(?:long\s+long\s+int|long\s+long|long\s+int|short\s+int|'
    r'long|short|int|char|float|double|void|'
    r'size_t|ssize_t|uint8_t|uint16_t|uint32_t|uint64_t|'
    r'int8_t|int16_t|int32_t|int64_t))'
    r'(\s*\*+\s*|\s+)'
    r'([a-zA-Z_]\w*)'
    r'(?:\s*\[(\d+)\])?'
    r'\s*(?:=\s*([^;{]+?))?'
    r'\s*;'
)

FUNC_RE = re.compile(
    r'^\s*'
    r'(?:(?:static|extern|inline|__attribute__\([^)]+\))\s+)*'
    r'(?:(?:unsigned\s+|signed\s+)?(?:long\s+long|long|short|int|char|float|double|void|'
    r'size_t|uint\w+|int\w+|\w+))'
    r'(?:\s*\*+\s*|\s+)'
    r'([a-zA-Z_]\w*)'
    r'\s*\([^)]*\)'
    r'\s*\{'
)


def _find_alloc_calls(line):
    results = []
    for func in ('malloc', 'calloc', 'realloc'):
        idx = 0
        while True:
            pos = line.find(func + '(', idx)
            if pos == -1:
                break
            if pos > 0 and (line[pos - 1].isalnum() or line[pos - 1] == '_'):
                idx = pos + 1
                continue
            start = pos + len(func)
            depth = 0
            end = start
            for i in range(start, len(line)):
                if line[i] == '(':
                    depth += 1
                elif line[i] == ')':
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
            results.append((func, line[start + 1:end]))
            idx = end + 1
    return results


def parse_c_source(c_code):
    clean = strip_comments(c_code)
    lines = clean.split('\n')

    segments = {'text': [], 'data': [], 'bss': [], 'heap': [], 'stack': []}

    depth = 0
    current_func = None
    func_locals = []

    for i, line in enumerate(lines):
        line_num = i + 1

        if depth == 0 and '{' in line:
            fm = FUNC_RE.match(line)
            if fm:
                fname = fm.group(1)
                if fname not in KEYWORDS:
                    current_func = fname
                    func_locals = []
                    segments['text'].append({
                        'name': fname, 'type': 'function',
                        'size': 0, 'line': line_num
                    })

        for ch in line:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0 and current_func:
                    frame_size = sum(v['size'] for v in func_locals)
                    segments['stack'].append({
                        'function': current_func,
                        'vars': func_locals,
                        'frame_size': frame_size,
                    })
                    current_func = None
                    func_locals = []

        vm = VAR_RE.match(line)
        if vm:
            type_str = vm.group(1).strip()
            ptr_part = vm.group(2).strip()
            name = vm.group(3)
            array_dim = vm.group(4)
            value = vm.group(5)

            if '*' in ptr_part:
                type_str = type_str + ' *'

            size = get_type_size(type_str)
            if array_dim:
                size *= int(array_dim)
            elif value and type_str.strip() == 'char' and '"' in value:
                size = len(value.strip().strip('"')) + 1

            entry = {
                'name': name, 'type': type_str,
                'size': size, 'line': line_num
            }

            if current_func is None and depth == 0:
                if value and value.strip():
                    segments['data'].append({**entry, 'value': value.strip()})
                else:
                    segments['bss'].append(entry)
            elif current_func and depth >= 1:
                func_locals.append({
                    **entry,
                    'value': value.strip() if value else None
                })

        for call, args in _find_alloc_calls(line):
            args = args.strip()
            alloc_size = _parse_alloc_size(args)
            segments['heap'].append({
                'call': call, 'size': alloc_size,
                'function': current_func or 'global',
                'line': line_num
            })

    return segments


def _parse_alloc_size(args):
    m = re.match(r'^(\d+)$', args)
    if m:
        return int(m.group(1))
    m = re.match(r'^(\d+)\s*\*\s*sizeof\s*\(\s*(\w+)\s*\)', args)
    if m:
        return int(m.group(1)) * get_type_size(m.group(2))
    m = re.match(r'^sizeof\s*\(\s*(\w+)\s*\)\s*\*\s*(\d+)', args)
    if m:
        return get_type_size(m.group(1)) * int(m.group(2))
    return '?'


# ── ARM64 assembly parser ──────────────────────────────────────────────────

def parse_assembly_arm64(asm_text):
    frames = {}
    current_func = None

    for raw_line in asm_text.split('\n'):
        line = raw_line.strip()
        if not line or line.startswith(';'):
            continue

        code = line.split(';')[0].strip()
        if not code:
            continue

        lm = re.match(r'^_?([a-zA-Z_]\w*):$', code)
        if lm:
            name = lm.group(1)
            if not re.match(r'^[Ll][A-Z0-9_]', name) and name not in ('data', 'text', 'bss'):
                current_func = name
                if current_func not in frames:
                    frames[current_func] = {'size': 0, 'slots': []}
            continue

        if not current_func:
            continue

        m = re.match(r'sub\s+sp,\s+sp,\s+#(\d+)', code)
        if m:
            frames[current_func]['size'] = max(frames[current_func]['size'], int(m.group(1)))
            continue

        m = re.match(r'stp\s+x29,\s+x30,\s+\[sp,\s+#-(\d+)\]!', code)
        if m:
            frames[current_func]['size'] = max(frames[current_func]['size'], int(m.group(1)))
            continue

        m = re.match(r'str\s+(w\d+|x\d+|s\d+|d\d+),\s+\[sp,\s+#(\d+)\]', code)
        if m:
            reg = m.group(1)
            offset = int(m.group(2))
            size = 8 if reg[0] in ('x', 'd') else 4
            if not any(s['offset'] == offset for s in frames[current_func]['slots']):
                frames[current_func]['slots'].append({'offset': offset, 'size': size})

    return frames


# ── x86_64 assembly parser (AT&T syntax) ──────────────────────────────────

def parse_assembly_x86_64(asm_text):
    frames = {}
    current_func = None

    for raw_line in asm_text.split('\n'):
        line = raw_line.strip()
        if not line or line.startswith('.') or line.startswith('#'):
            continue

        code = line.split('#')[0].strip()
        if not code:
            continue

        lm = re.match(r'^_?([a-zA-Z_]\w*):$', code)
        if lm:
            name = lm.group(1)
            if not re.match(r'^[Ll][A-Z0-9_]', name) and name not in ('data', 'text', 'bss'):
                current_func = name
                if current_func not in frames:
                    frames[current_func] = {'size': 0, 'slots': []}
            continue

        if not current_func:
            continue

        # subq $N, %rsp — stack allocation
        m = re.match(r'subq\s+\$(\d+),\s+%rsp', code)
        if m:
            frames[current_func]['size'] = max(frames[current_func]['size'], int(m.group(1)))
            continue

        # movX ..., -N(%rbp) — variable slot store
        m = re.match(r'(mov[lqwb])\s+.+,\s+-(\d+)\(%rbp\)', code)
        if m:
            op = m.group(1)
            offset = int(m.group(2))
            size = {'movq': 8, 'movl': 4, 'movw': 2, 'movb': 1}.get(op, 4)
            if not any(s['offset'] == -offset for s in frames[current_func]['slots']):
                frames[current_func]['slots'].append({'offset': -offset, 'size': size})

    return frames


# ── Stack frame builder ────────────────────────────────────────────────────

def build_stack_frames(c_segments, asm_frames, arch='arm64'):
    result = []

    for stack_info in c_segments.get('stack', []):
        func_name = stack_info['function']
        c_vars = stack_info['vars']
        asm = asm_frames.get(func_name, {})

        frame_size = asm.get('size', stack_info['frame_size'])
        slots = sorted(asm.get('slots', []), key=lambda s: s['offset'])

        used = set()
        enriched = []
        for var in c_vars:
            matched = False
            for j, slot in enumerate(slots):
                if j not in used and slot['size'] == var['size']:
                    enriched.append({**var, 'sp_offset': slot['offset']})
                    used.add(j)
                    matched = True
                    break
            if not matched:
                enriched.append({**var, 'sp_offset': None})

        parts = []
        if frame_size > 0:
            if arch == 'x86_64':
                parts.append({'label': 'return address (rip)', 'size': 8, 'kind': 'meta'})
                parts.append({'label': 'saved frame ptr (rbp)', 'size': 8, 'kind': 'meta'})
            else:
                parts.append({'label': 'return address (lr/x30)', 'size': 8, 'kind': 'meta'})
                parts.append({'label': 'saved frame ptr (x29)', 'size': 8, 'kind': 'meta'})

        for v in enriched:
            if arch == 'x86_64':
                offset_val = v['sp_offset']
                offset_str = (f"rbp{offset_val}" if offset_val is not None else '??')
            else:
                offset_val = v['sp_offset']
                offset_str = (f"sp+{offset_val}" if offset_val is not None else '??')
            parts.append({
                'label': f"{v['type']} {v['name']}",
                'size': v['size'],
                'kind': 'var',
                'sp_offset': v.get('sp_offset'),
                'offset_str': offset_str,
                'value': v.get('value'),
            })

        result.append({
            'function': func_name,
            'frame_size': frame_size,
            'parts': parts,
        })

    return result
