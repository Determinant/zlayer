#!/usr/bin/env python3
"""Check the HTTPS origin without changing DNS (Python 3 and curl only)."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--address', required=True)
parser.add_argument('--https-port', default='443')
parser.add_argument('--http-port', default='80')
parser.add_argument('--app-domain', required=True)
parser.add_argument('--charts-domain', required=True)
parser.add_argument('--mbtiles', help='Published /charts/...mbtiles path for a range check')
parser.add_argument('--pdf', help='Published /faa-procedures/<cycle>/<filename>.PDF path')
parser.add_argument('--wasm', help='Published /assets/...wasm path for its MIME and magic-byte check')
args = parser.parse_args()
reads = 0


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(domain, path, status=200, method='GET', headers=(), http=False):
    global reads
    scheme, port, destination = ('http', '80', args.http_port) if http else ('https', '443', args.https_port)
    url = f'{scheme}://{domain}{path}'
    with tempfile.TemporaryDirectory(prefix='zlayer-hosting-check-') as folder:
        head, body = Path(folder) / 'headers', Path(folder) / 'body'
        body.touch()  # curl can omit its output file for a bodyless 304 response.
        command = ['curl', '--disable', '--silent', '--show-error', '--noproxy', '*', '--max-time', '120',
                   '--max-filesize', str(64 * 1024 * 1024),
                   '--connect-to', f'{domain}:{port}:{args.address}:{destination}',
                   '--dump-header', str(head), '--output', str(body), '--write-out', '%{http_code}']
        command += ['--head'] if method == 'HEAD' else ['--request', method]
        for header in headers:
            command += ['--header', header]
        code = subprocess.check_output(command + [url], text=True).strip()
        require(code == str(status), f'{url}: expected {status}, got {code}')
        block = head.read_text().strip().split('\n\n')[-1]
        fields = {k.lower(): v.strip() for k, v in
                  (line.split(':', 1) for line in block.splitlines()[1:] if ':' in line)}
        data = body.read_bytes()
    reads += 1
    return fields, data


app, charts = args.app_domain, args.charts_domain
for domain in [app, charts]:
    headers, _ = read(domain, '/?migration-check=1', status=308, http=True)
    require(headers.get('location') == f'https://{domain}/?migration-check=1', 'HTTPS redirect lost the URL')
    read(domain, '/.git/config', 404)
    read(domain, '/.publication-backups/', 404)
    read(domain, '/', 405, method='POST')

headers, html = read(app, '/')
require('text/html' in headers.get('content-type', ''), 'HTML MIME type')
require(headers.get('cache-control') == 'no-cache', 'HTML must revalidate')
conditional, _ = read(app, '/', 304, headers=['If-None-Match: ' + headers['etag']])
require(conditional.get('cache-control') == 'no-cache', 'HTML 304 must revalidate')
release = re.search(r'name="zlayer-release" content="([a-f0-9]+)"', html.decode())
require(release is not None, 'Shell has no release identity')
headers, archive = read(app, f'/source/{release.group(1)}.tar.gz')
require(archive.startswith(b'\x1f\x8b'), 'Frontend corresponding source is missing')
require('immutable' in headers.get('cache-control', ''), 'Source archive caching')
headers, _ = read(app, '/sw.js')
require(headers.get('cache-control') == 'no-store', 'Worker must not be cached')
require(headers.get('service-worker-allowed') == '/', 'Worker scope')
require('javascript' in headers.get('content-type', ''), 'Worker MIME type')
headers, _ = read(app, '/manifest.webmanifest')
require(headers.get('content-type', '').startswith('application/manifest+json'), 'Manifest MIME type')
assets = set(re.findall(r'/assets/[^"\s<>]+', html.decode()))
require(bool(assets), 'Shell has no assets')
for path in sorted(assets):
    headers, _ = read(app, path, method='HEAD')
    require('immutable' in headers.get('cache-control', ''), f'{path}: immutable caching')
path = sorted(assets)[0]
headers, _ = read(app, path, method='HEAD')
conditional, _ = read(app, path, 304, headers=['If-None-Match: ' + headers['etag']])
require('immutable' in conditional.get('cache-control', ''), 'Asset 304 caching')
for path in ['/assets/does-not-exist.js', '/source/does-not-exist.tar.gz',
             '/chart-data/does-not-exist.json', '/api/does-not-exist',
             '/faa-procedures/invalid/file.PDF', '/faa-procedures/2610/https://example.com/file.PDF']:
    headers, _ = read(app, path, 404)
    require('immutable' not in headers.get('cache-control', ''), f'{path}: missing files must not be immutable')
read(app, '/api/weather/healthz', 405, method='POST')

headers, feed = read(charts, '/charts/cycles.json', headers=['Origin: https://' + app])
require(headers.get('access-control-allow-origin') == '*', 'Chart CORS')
require(headers.get('cache-control') == 'no-cache', 'Feed discovery must revalidate')
require(bool(json.loads(feed)['cycles']), 'Empty chart discovery')
_, same_origin = read(app, '/chart-data/cycles.json')
require(feed == same_origin, 'App and chart host serve different discovery bytes')
headers, _ = read(charts, '/charts/cycles.json', status=204, method='OPTIONS',
                  headers=['Origin: https://' + app, 'Access-Control-Request-Method: GET',
                           'Access-Control-Request-Headers: Range'])
require('Range' in headers.get('access-control-allow-headers', ''), 'Range preflight')
for path in ['/', '/charts/', '/aim/', '/far/']:
    read(charts, path)
headers, _ = read(charts, '/charts/does-not-exist.mbtiles', 404,
                  headers=['Origin: https://' + app])
require(headers.get('access-control-allow-origin') == '*', 'Chart errors must remain readable through CORS')

headers, health_bytes = read(app, '/api/weather/healthz')
health = json.loads(health_bytes)
require(health.get('ok') is True, 'Info process is not healthy')
require(headers.get('cache-control') == 'no-store', 'API must not be cached')
for family, products in [('forecasts', ['clouds', 'icing', 'winds']), ('progs', ['analysis', 'forecast'])]:
    for product in products:
        require(health[family][product]['ready'], f'{family}/{product} is not ready')
for product in ['progsCoverage', 'radar', 'radarMotion']:
    require(health[product]['ready'], f'{product} is not ready')
for product in ['clouds', 'icing', 'winds']:
    headers, data = read(app, f'/api/weather/grids/{product}.json')
    require(headers.get('x-weather-catalog') == 'complete-native-v1', f'{product}: identity header')
    require(bool(json.loads(data)['frames']), f'{product}: no prepared frames')
for path in ['/api/weather/metars.geojson?ids=KSFO', '/api/weather/tafs.json?ids=KSFO', '/api/notams/healthz']:
    _, data = read(app, path)
    json.loads(data)
source = urlsplit(health.get('source', ''))
require(source.scheme == 'https' and source.hostname == app, 'Backend source offer must use the app host')
_, archive = read(app, source.path)
require(archive.startswith(b'\x1f\x8b'), 'Backend corresponding source is missing')

if args.wasm:
    require(args.wasm.startswith('/assets/'), '--wasm must be an /assets/ path')
    headers, data = read(app, args.wasm)
    require(headers.get('content-type') == 'application/wasm', 'WASM MIME type')
    require(data.startswith(b'\x00asm'), 'WASM bytes')

if args.mbtiles:
    require(args.mbtiles.startswith('/charts/'), '--mbtiles must be a /charts/ path')
    headers, whole = read(charts, args.mbtiles)
    require(whole.startswith(b'SQLite format 3\x00'), 'Whole-file MBTiles delivery')
    require(int(headers['content-length']) == len(whole), 'Whole-file MBTiles length')
    digest = re.search(r'([a-f0-9]{64})\.mbtiles$', args.mbtiles)
    if digest:
        require(hashlib.sha256(whole).hexdigest() == digest.group(1), 'Whole-file MBTiles checksum')
    headers, data = read(charts, args.mbtiles, 206, headers=['Range: bytes=0-15'])
    require(data == b'SQLite format 3\x00', 'Range did not preserve MBTiles bytes')
    require(headers.get('content-range', '').startswith('bytes 0-15/'), 'Content-Range missing')
    _, same_origin = read(app, args.mbtiles.replace('/charts/', '/chart-data/', 1),
                          206, headers=['Range: bytes=0-15'])
    require(same_origin == data, 'Same-origin MBTiles range differs')
if args.pdf:
    require(args.pdf.startswith('/faa-procedures/'), '--pdf must be a /faa-procedures/ path')
    headers, data = read(app, args.pdf + '?migration-check=1')
    require(data.startswith(b'%PDF-'), 'FAA proxy did not return a PDF')
    require('application/pdf' in headers.get('content-type', ''), 'FAA PDF MIME type')

print(json.dumps({'requests': reads, 'address': args.address, 'tlsVerified': True,
                  'discoverySha256': hashlib.sha256(feed).hexdigest(),
                  'notams': health.get('notams'), 'source': health.get('source')}, indent=2))
print('Hosting checks passed. NOTAM collection readiness is reported separately; run check-info-api for full backend release qualification.')
