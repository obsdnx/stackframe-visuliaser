from flask import Flask, request, jsonify
from flask_cors import CORS
from analyzer import (
    compile_to_assembly, parse_c_source,
    parse_assembly_arm64, parse_assembly_x86_64,
    build_stack_frames,
)
from tracer import generate_trace

app = Flask(__name__)
CORS(app)

SUPPORTED_ARCHES = {'arm64', 'x86_64'}


@app.route('/api/compile', methods=['POST'])
def compile_endpoint():
    data = request.get_json(silent=True)
    if not data or 'code' not in data:
        return jsonify({'error': 'No code provided'}), 400

    c_code = data['code']
    arch = data.get('arch', 'arm64')
    if arch not in SUPPORTED_ARCHES:
        arch = 'arm64'

    if len(c_code) > 64_000:
        return jsonify({'error': 'Code too large (max 64KB)'}), 400

    assembly, compile_msg = compile_to_assembly(c_code, arch=arch)

    if assembly is None:
        return jsonify({
            'assembly': None,
            'segments': None,
            'stack_frames': None,
            'error': compile_msg,
        })

    c_segments = parse_c_source(c_code)

    if arch == 'x86_64':
        asm_frames = parse_assembly_x86_64(assembly)
    else:
        asm_frames = parse_assembly_arm64(assembly)

    for func_info in c_segments.get('text', []):
        name = func_info['name']
        if name in asm_frames:
            func_info['size'] = asm_frames[name].get('size', 0)

    stack_frames = build_stack_frames(c_segments, asm_frames, arch=arch)

    return jsonify({
        'assembly': assembly,
        'segments': c_segments,
        'stack_frames': stack_frames,
        'warnings': compile_msg,
        'error': None,
    })


@app.route('/api/trace', methods=['POST'])
def trace_endpoint():
    data = request.get_json(silent=True)
    if not data or 'code' not in data:
        return jsonify({'error': 'No code provided'}), 400

    c_code = data['code']
    arch = data.get('arch', 'arm64')
    if arch not in SUPPORTED_ARCHES:
        arch = 'arm64'

    if len(c_code) > 64_000:
        return jsonify({'error': 'Code too large (max 64KB)'}), 400

    disassembly, trace, err = generate_trace(c_code, arch=arch)

    if err and not disassembly:
        return jsonify({
            'disassembly': None,
            'trace': [],
            'segments': None,
            'stack_frames': None,
            'error': err,
        })

    c_segments = parse_c_source(c_code)
    asm_frames = {}
    if disassembly:
        try:
            asm_frames = parse_assembly_arm64(disassembly)
        except Exception:
            asm_frames = {}

    for func_info in c_segments.get('text', []):
        name = func_info['name']
        if name in asm_frames:
            func_info['size'] = asm_frames[name].get('size', 0)

    stack_frames = build_stack_frames(c_segments, asm_frames, arch=arch)

    return jsonify({
        'disassembly': disassembly,
        'trace': trace,
        'segments': c_segments,
        'stack_frames': stack_frames,
        'error': err,
    })


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    app.run(debug=True, port=5001)
