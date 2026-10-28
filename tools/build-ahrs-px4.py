#!/usr/bin/env python3
"""Rebuild the pinned PX4 module. Requires Emscripten 5.0.6 and patch.

No downloads, source generation dependencies, or compiler are needed by npm build.
The checked-in generated module is verified against its input hashes by --check.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PORT = ROOT / 'src/layers/ahrs/estimator/px4'
VENDOR = PORT / 'vendor'
MANIFEST = json.loads((PORT / 'upstream.json').read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted([
        Path(__file__).resolve(), PORT / 'upstream.json', PORT / 'browser.patch',
        PORT / 'bridge.cpp', PORT / 'snapshot.json', *[VENDOR / p for p in MANIFEST['sha256']]])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--native', help='Build the C ABI as a native shared library for parity tests')
    args = parser.parse_args()
    for path, expected in MANIFEST['sha256'].items():
        if digest(VENDOR / path) != expected:
            raise SystemExit(f'Upstream source changed: {path}; use browser.patch')
    output = PORT / 'generated/ekf.js'
    stamp = PORT / 'generated/build.json'
    if args.check:
        expected = json.loads(stamp.read_text())
        if expected['inputs'] != inputs() or expected['output'] != digest(output):
            raise SystemExit('PX4 generated module is stale; run npm run ahrs:build')
        return
    with tempfile.TemporaryDirectory(prefix='zlayer-px4-') as temp:
        build = Path(temp)
        tree = build / 'vendor'
        shutil.copytree(VENDOR, tree)
        subprocess.run(['patch', '-s', '-p1', '-i', str(PORT / 'browser.patch')], cwd=tree, check=True)
        inc = build / 'include'
        (inc / 'uORB/topics').mkdir(parents=True)
        (inc / 'px4_boardconfig.h').write_text('#pragma once\n')
        layout = json.loads((PORT / 'snapshot.json').read_text())
        (inc / 'snapshot.h').write_text('#pragma once\n' + '\n'.join(
            'namespace ' + namespace + ' {\n' + '\n'.join(
                f'constexpr unsigned {name} = {offset};' for name, offset in layout[key].items()) + '\n}'
            for key, namespace in [('state', 'Snapshot'), ('aid', 'Aid'), ('headingSource', 'HeadingSource')]))
        # Only the data structs are needed; uORB publication/runtime is not used.
        for dimension in (1, 2, 3):
            name = f'estimator_aid_source{dimension}d'
            fields = []
            for line in (tree / f'msg/EstimatorAidSource{dimension}d.msg').read_text().splitlines():
                line = line.split('#')[0].strip()
                if not line:
                    continue
                kind, field = line.split()
                length = ''
                if '[' in kind:
                    kind, length = kind.split('[')
                    length = '[' + length
                ctype = {'uint64': 'uint64_t', 'uint32': 'uint32_t', 'uint8': 'uint8_t',
                         'float32': 'float', 'float64': 'double', 'bool': 'bool'}[kind]
                fields.append(f'  {ctype} {field}{length}{{}};')
            (inc / f'uORB/topics/{name}.h').write_text(
                '#pragma once\n#include <cstdint>\nstruct ' + name + '_s {\n' + '\n'.join(fields) + '\n};\n')
        ekf = tree / 'src/modules/ekf2/EKF'
        includes = [inc, tree / 'src', tree / 'src/lib', tree / 'src/lib/matrix',
                    tree / 'platforms/common/include', ekf, ekf / 'python']
        command = ['clang++' if args.native else 'em++', '-std=c++17', '-O2', '-include', 'cstdio',
                   f'-ffile-prefix-map={build}=/px4-build', f'-ffile-prefix-map={ROOT}=/zlayer',
                   *['-I' + str(p) for p in includes], *['-D' + d for d in MANIFEST['defines']],
                   str(PORT / 'bridge.cpp'), *[str(tree / p) for p in MANIFEST['sources']]]
        if args.native:
            command += ['-shared', '-fPIC', '-o', args.native]
        else:
            version = subprocess.check_output(['em++', '--version'], text=True).splitlines()[0]
            if '5.0.6' not in version:
                raise SystemExit('Use Emscripten 5.0.6 for reproducible builds')
            output.parent.mkdir(exist_ok=True)
            exports = ['create', 'destroy', 'configure', 'seed', 'accel_bias', 'imu', 'gps', 'mag', 'heading', 'ground', 'state', 'covariance']
            command += ['-o', str(output), '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sSINGLE_FILE=1',
                        '-sWASM_ASYNC_COMPILATION=0', '-sENVIRONMENT=web', '-sFILESYSTEM=0',
                        '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16777216',
                        '-sEXPORTED_RUNTIME_METHODS=["HEAPF64"]',
                        '-sEXPORTED_FUNCTIONS=' + json.dumps(['_px4_' + name for name in exports])]
        subprocess.run(command, check=True)
        if not args.native:
            # Ship the required binary redistribution notice with the module.
            notice = '/*! PX4 v1.17.0, BSD-3-Clause. See ../vendor/LICENSE and upstream source copyright notices. */\n'
            output.write_text(notice + output.read_text())
            stamp.write_text(json.dumps({'compiler': version, 'inputs': inputs(), 'output': digest(output)}, indent=2) + '\n')


if __name__ == '__main__':
    main()
