# stackframe

An interactive C memory visualiser. Write C code in the browser, compile it on a real Linux backend, and watch the stack frames, assembly, memory segments, and CPU registers update live — instruction by instruction.

**Live demo:** https://harare.systemsobsidian.workers.dev

---

## What it does

Most tools that teach memory layout show you a static diagram. This one compiles your actual code with `gcc -O0`, disassembles the binary, emulates the CPU, and lets you step through every instruction while every panel stays in sync:

- The **assembly panel** highlights the current instruction as the PC moves
- The **C source editor** syncs to the exact source line via DWARF debug info
- The **register panel** diffs every register against the previous step — changed registers light up
- The **stack frame panel** shows every function's frame with variable names, types, sizes, and `sp`/`rbp`-relative offsets pulled from real assembly
- The **memory map** classifies globals into TEXT / DATA / BSS segments and heap allocations from `malloc` calls parsed statically from the source
- A plain-English **instruction explainer** translates each instruction — "Allocate 48 bytes on the stack — reserve space for local variables" — into something a student can actually read

Both ARM64 and x86-64 are supported end to end.

---

## Architecture

```
Browser (Cloudflare Workers CDN)
  └── React 19 + CodeMirror 6 + Vite

           POST /api/compile
           POST /api/trace
                 │
                 ▼
Flask API (Fly.io · London · Docker)
  ├── analyzer.py   ← C source parser + assembly parser
  └── tracer.py     ← compiler pipeline + CPU emulator
          │
          ├── gcc -O0          compile to binary / assembly
          ├── objdump -d       disassemble binary (Linux)
          └── addr2line -e     map addresses → source lines (DWARF)
```

---

## How the emulator works

There is no third-party emulation library. The ARM64 and x86-64 emulators are written from scratch in plain Python.

`tracer.py` compiles the user's C code to a native binary with debug symbols, disassembles it with `objdump`, parses the output into an address-indexed instruction table, then runs a fetch–decode–execute loop starting from `main`:

```
pc = func_map['main']
while step < MAX_STEPS:
    instr = instr_by_addr[pc]
    mem_writes = emulator.execute(instr)
    trace.append({ pc, instruction, registers, mem_writes, ... })
    pc = emulator.pc
```

The ARM64 emulator handles: `sub/add/mul/mov/movz/movk`, `str/stur/strb`, `stp/ldp`, `ldr/ldur/ldrb`, `bl/ret`, `cmp`, conditional branches (`b.eq` through `b.le`), `adrp/adr`, `fmov`, and a simulated `malloc` that returns addresses from a bump allocator. The x86-64 emulator handles AT&T syntax including all `movX/subX/addX/imulX`, `pushq/popq`, `leaq`, `xor/and/or/not/neg`, `sarX/shrX/shlX`, `cmpX/testX`, all conditional jumps (`je/jne/jl/jle/jg/jge/ja/jb`), and `callq/retq` with proper return address management.

After the trace is built, `addr2line` maps each instruction's address to a C source line number using the DWARF debug info embedded in the binary. That line number is what drives the source editor sync.

---

## Stack frame reconstruction

`analyzer.py` runs two parsers and merges them:

1. **C source parser** — a regex pass over the stripped source that identifies function bodies, classifies local variables by type and infers sizes (`int` → 4 bytes, `char *` → 8 bytes, `char[32]` → 32 bytes, etc.), and detects `malloc`/`calloc`/`realloc` call sites
2. **Assembly parser** — scans `gcc -S` output for `sub sp, sp, #N` (ARM64 frame allocation) or `subq $N, %rsp` (x86-64), and records every `str`/`mov` slot that maps a register to a stack offset

The two are fused by matching C variable sizes to assembly slot sizes, producing a complete frame layout with actual `sp`-relative (ARM64) or `rbp`-relative (x86-64) offsets for every named variable.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, CodeMirror 6 |
| Backend | Python 3.12, Flask 3, flask-cors |
| Toolchain | gcc, objdump (binutils), addr2line |
| Containerisation | Docker (python:3.12-slim) |
| Frontend hosting | Cloudflare Workers (static assets) |
| Backend hosting | Fly.io (shared-cpu-1x, 256 MB, London) |

---

## Running locally

**Backend**

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py          # listens on :5001
```

Requires `gcc` and `binutils` (`objdump`, `addr2line`). On macOS the backend also accepts `otool` + `atos` as fallbacks — the platform is detected at runtime.

**Frontend**

```bash
cd frontend
npm install
npm run dev            # listens on :5173
```

Set `VITE_API_URL=http://localhost:5001` if the backend is not on the same origin.

---

## Deployment

**Backend — Fly.io**

```bash
cd backend
fly auth login
fly launch --copy-config   # first deploy: provisions the app
fly deploy                 # subsequent deploys
```

The `Dockerfile` installs `gcc` and `binutils` on top of `python:3.12-slim`. The app reads `PORT` from the environment and binds `0.0.0.0` for container networking.

**Frontend — Cloudflare**

```bash
cd frontend && npm run build
cd ..
wrangler deploy            # deploys frontend/dist via wrangler.jsonc
```

The production backend URL is embedded at build time via `VITE_API_URL` in `frontend/.env.production`.
