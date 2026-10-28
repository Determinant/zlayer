#!/usr/bin/env python3
"""Compare native clang and browser WASM executions of the vendored PX4 bridge.

Run from the repository root. Requires clang++, Python and Node, not Emscripten.
This establishes execution agreement; it is not an independent accuracy test.
"""
import ctypes as c
import json
import math
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE_SIZE = json.loads((ROOT / 'src/layers/ahrs/estimator/px4/snapshot.json').read_text())['state']['STARTED']
with tempfile.TemporaryDirectory(prefix='zlayer-px4-parity-') as directory:
    library = Path(directory) / 'px4.so'
    subprocess.run(['python3', 'tools/build-ahrs-px4.py', '--native', str(library)], cwd=ROOT, check=True)
    native = c.CDLL(str(library))
    native.px4_create.restype = c.c_void_p
    for name, args in {
        'destroy': [], 'imu': [c.c_double] * 7,
        'seed': [c.c_double] * 4 + [c.c_int] + [c.c_double] * 4,
        'gps': [c.c_double] * 10 + [c.c_int] * 5,
        'heading': [c.c_double] * 2, 'state': [], 'covariance': [],
    }.items():
        getattr(native, 'px4_' + name).argtypes = [c.c_void_p, *args]
    native.px4_state.restype = native.px4_covariance.restype = c.POINTER(c.c_double)
    pointer = native.px4_create()
    events, expected = [], []
    def call(name, *args):
        events.append([name, *args])
        getattr(native, 'px4_' + name)(pointer, *args)
    call('seed', .003, -.003, .005, .001, 1, 1, 0, 0, 0)
    for index in range(60 * 60 + 1):
        time = index / 60
        vibration = math.sin(2 * math.pi * 7.3 * time)
        call('imu', time, .003 + .03 * vibration, -.003 + .02 * vibration, .005,
             2 * vibration, vibration, -9.80665 + 2 * vibration)
        if index == 1800:
            call('heading', 1.2, .03)
        if index > 1800 and index % 60 == 0:
            call('gps', time, 37, -122, 100, 2, 4, 0, 0, 0, 1.5, 1, 0, 1, 1, 1)
        if index > 0 and index % 300 == 0:
            call('state')
            expected.append([*native.px4_state(pointer)[:STATE_SIZE], *native.px4_covariance(pointer)[:24 * 24]])
    native.px4_destroy(pointer)
    script = """
import create from './src/layers/ahrs/estimator/px4/generated/ekf.js';
import layout from './src/layers/ahrs/estimator/px4/snapshot.json' with { type: 'json' };
const chunks=[];for await (const chunk of process.stdin) chunks.push(chunk);
const events=JSON.parse(Buffer.concat(chunks).toString());
const m=await create({print(){},printErr(){}}), p=m._px4_create(), result=[];
for(const [name,...args] of events){
  if(name==='state'){
    const s=m._px4_state(p)/8, state=[...m.HEAPF64.slice(s,s+layout.state.STARTED)];
    const c=m._px4_covariance(p)/8;result.push([...state,...m.HEAPF64.slice(c,c+24*24)]);
  }else m['_px4_'+name](p,...args);
}
m._px4_destroy(p);process.stdout.write(JSON.stringify(result));
"""
    actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script],
        cwd=ROOT, input=json.dumps(events), text=True))
    assert len(actual) == len(expected)
    maximum = 0.
    for n, (a, e) in enumerate(zip(actual, expected)):
        for i, (value, reference) in enumerate(zip(a, e)):
            error = abs(value - reference) / max(1., abs(reference))
            maximum = max(maximum, error)
            assert error < 2e-5, (n, i, value, reference, error)
    print(f'Native/WASM parity: {len(actual)} snapshots, full 24×24 covariance; maximum normalized difference {maximum:.3g}')
