#!/usr/bin/env python3
"""Exercise the real Caddy routes with temporary files and a loopback upstream."""
import argparse
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--caddy', default='caddy', help='Path to the Caddy executable')
parser.add_argument('--config', type=Path, default=Path(__file__).with_name('Caddyfile'))
args = parser.parse_args()
APP, CHARTS = 'app.example.test', 'charts.example.test'


class Upstream(http.server.BaseHTTPRequestHandler):
    def respond(self):
        self.server.requests.append((self.command, self.path))
        body = b'upstream fixture'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = respond

    def log_message(self, *_args):
        pass


class Routing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory(prefix='zlayer-caddy-routing-')
        cls.addClassCleanup(folder.cleanup)
        root = Path(folder.name)
        cls.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.upstream.requests = []
        cls.addClassCleanup(cls.upstream.server_close)
        cls.addClassCleanup(cls.upstream.shutdown)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()

        cls.static = {
            '/': ('app/current', 'index.html'),
            '/chart-data/': ('faa/charts', 'cycles.json'),
            '/assets/': ('app/assets', 'app.js'),
            '/source/': ('app/source', 'release.tar.gz'),
        }
        for directory, filename in cls.static.values():
            for relative in [filename, '.secret', '.private/secret', 'nested/.secret']:
                path = root / directory / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture bytes')
        (root / 'app/current/sw.js').write_text('// worker fixture\n')
        for product in ['far', 'aim']:
            product_folder = root / 'faa' / product
            product_folder.mkdir(parents=True)
            (product_folder / 'index.html').write_text('<!doctype html><title>PWA fixture</title>')
            (product_folder / 'manifest.webmanifest').write_text('{"start_url":"./"}')
            (product_folder / 'service-worker.js').write_text('// product worker fixture\n')

        env = dict(os.environ, APP_DOMAIN=APP, CHARTS_DOMAIN=CHARTS,
                   APP_TLS_MODE='managed', CHARTS_TLS_MODE='managed',
                   XDG_DATA_HOME=str(root / 'data'), XDG_CONFIG_HOME=str(root / 'config'))
        result = subprocess.run([args.caddy, 'adapt', '--config', str(args.config),
                                 '--adapter', 'caddyfile'], env=env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        config = json.loads(result.stdout)
        # Keep the adapted handlers intact. Substitute only deployment resources:
        # filesystem roots, upstream endpoints, TLS and the listening address.
        server = next(server for server in config['apps']['http']['servers'].values()
                      if ':443' in server['listen'])
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        server['listen'] = [f'127.0.0.1:{cls.port}']
        server['automatic_https'] = {'disable': True}
        server.pop('tls_connection_policies', None)
        config['apps']['http']['servers'] = {'test': server}
        config['apps'].pop('tls', None)
        config['admin'] = {'disabled': True}

        def fixtures(node):
            if isinstance(node, list):
                for value in node:
                    fixtures(value)
            elif isinstance(node, dict):
                if node.get('handler') == 'reverse_proxy':
                    node['upstreams'] = [{'dial': f'127.0.0.1:{cls.upstream.server_port}'}]
                    node.get('transport', {}).pop('tls', None)
                for key, value in node.items():
                    if isinstance(value, str) and value.startswith('/srv/'):
                        node[key] = str(root / value.removeprefix('/srv/'))
                    else:
                        fixtures(value)

        fixtures(config)
        config_path = root / 'caddy.json'
        config_path.write_text(json.dumps(config))
        log = (root / 'caddy.log').open('w+')
        cls.addClassCleanup(log.close)
        cls.caddy = subprocess.Popen([args.caddy, 'run', '--config', str(config_path)],
                                     env=env, stdout=log, stderr=log)

        def stop():
            cls.caddy.terminate()
            try:
                cls.caddy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.caddy.kill()
                cls.caddy.wait()

        cls.addClassCleanup(stop)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and cls.caddy.poll() is None:
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.05)
        log.seek(0)
        raise RuntimeError('Caddy did not start:\n' + log.read())

    def setUp(self):
        self.upstream.requests.clear()

    def read(self, path, status=200, method='GET', domain=APP, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, headers={'Host': domain, **(headers or {})})
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, status, f'{method} {domain}{path}')
            return dict((k.lower(), v) for k, v in response.getheaders()), body
        finally:
            connection.close()

    def test_existing_hidden_files_are_denied(self):
        for prefix in self.static:
            for name in ['.secret', '.private/secret', 'nested/.secret', '%2esecret']:
                for method in ['GET', 'HEAD']:
                    with self.subTest(prefix=prefix, name=name, method=method):
                        self.read(prefix + name, 404, method=method)
        for prefix in ['/api/weather/', '/api/notams/']:
            self.read(prefix + '.secret', 404)
        self.assertEqual(self.upstream.requests, [])

    def test_disallowed_methods_never_reach_upstreams(self):
        paths = ['/', '/chart-data/cycles.json', '/assets/app.js', '/source/release.tar.gz',
                 '/sw.js', '/api/weather/healthz', '/api/notams/healthz',
                 '/faa-procedures/2610/TEST.PDF']
        for path in paths:
            for method in ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']:
                with self.subTest(path=path, method=method):
                    self.read(path, 405, method=method)
        self.assertEqual(self.upstream.requests, [])

    def test_allowed_static_reads_and_headers(self):
        for prefix, (_, filename) in self.static.items():
            for method in ['GET', 'HEAD']:
                with self.subTest(prefix=prefix, method=method):
                    headers, body = self.read(prefix + filename, method=method)
                    self.assertEqual(body, b'fixture bytes' if method == 'GET' else b'')
                    expected = 'public, max-age=31536000, immutable' if prefix in ['/assets/', '/source/'] else 'no-cache'
                    self.assertEqual(headers['cache-control'], expected)
        headers, _ = self.read('/sw.js')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(headers['service-worker-allowed'], '/')
        self.read('/chart-data/missing.json', 404)

    def test_allowed_proxy_reads_preserve_paths_and_queries(self):
        for path in ['/api/weather/healthz?test=1', '/api/notams/healthz?test=1',
                     '/faa-procedures/2610/TEST.PDF?test=1']:
            for method in ['GET', 'HEAD']:
                with self.subTest(path=path, method=method):
                    _, body = self.read(path, method=method)
                    self.assertEqual(body, b'upstream fixture' if method == 'GET' else b'')
                    self.assertEqual(self.upstream.requests[-1],
                                     (method, path.replace('/faa-procedures/', '/d-tpp/')))
        self.assertEqual(len(self.upstream.requests), 6)
        for path in ['/faa-procedures/invalid/TEST.PDF', '/faa-procedures/2610/TEST.txt']:
            self.read(path, 404)
        self.assertEqual(len(self.upstream.requests), 6)

    def test_chart_cors_ranges_and_hidden_files(self):
        origin = {'Origin': f'https://{APP}'}
        for method in ['GET', 'HEAD']:
            headers, body = self.read('/charts/cycles.json', method=method,
                                      domain=CHARTS, headers=origin)
            self.assertEqual(headers['access-control-allow-origin'], f'https://{APP}')
            self.assertEqual(body, b'fixture bytes' if method == 'GET' else b'')
        headers, _ = self.read('/charts/cycles.json', 304, domain=CHARTS,
                              headers={**origin, 'If-None-Match': headers['etag']})
        self.assertEqual(headers['access-control-allow-origin'], f'https://{APP}')
        headers, body = self.read('/charts/cycles.json', 206, domain=CHARTS,
                                  headers={**origin, 'Range': 'bytes=0-6'})
        self.assertEqual(body, b'fixture')
        self.assertEqual(headers['access-control-allow-origin'], f'https://{APP}')
        self.assertEqual(headers['content-range'], 'bytes 0-6/13')
        headers, _ = self.read('/charts/cycles.json', 204, method='OPTIONS', domain=CHARTS,
                              headers={**origin, 'Access-Control-Request-Method': 'GET',
                                       'Access-Control-Request-Headers': 'Range'})
        self.assertEqual(headers['access-control-allow-origin'], f'https://{APP}')
        self.assertIn('Range', headers['access-control-allow-headers'])
        headers, _ = self.read('/charts/missing.json', 404, domain=CHARTS, headers=origin)
        self.assertEqual(headers['access-control-allow-origin'], f'https://{APP}')
        self.read('/charts/cycles.json', 405, method='POST', domain=CHARTS)
        for path in ['/charts/.secret', '/charts/.private/secret', '/charts/nested/.secret']:
            self.read(path, 404, domain=CHARTS)

    def test_foreign_chart_origins_are_denied_before_delivery(self):
        for domain, path, methods in [
            (CHARTS, '/charts/cycles.json', ['GET', 'HEAD', 'OPTIONS']),
            (APP, '/chart-data/cycles.json', ['GET', 'HEAD']),
        ]:
            for origin in ['https://other.example', 'null', f'http://{APP}',
                           f'https://{APP}.other.example', f'https://{APP}:8443']:
                for method in methods:
                    with self.subTest(domain=domain, origin=origin, method=method):
                        headers, body = self.read(path, 403, method=method, domain=domain,
                                                  headers={'Origin': origin, 'Range': 'bytes=0-6'})
                        self.assertEqual(headers['cache-control'], 'no-store')
                        self.assertNotIn(b'fixture', body)
                        self.assertNotEqual(headers.get('access-control-allow-origin'), origin)
                        self.assertNotEqual(headers.get('access-control-allow-origin'), '*')
            # Public direct reads and the app's own requests remain available.
            for headers in [{}, {'Origin': f'https://{APP}'}]:
                self.read(path, domain=domain, headers=headers)

    def test_chart_host_own_pwas_remain_accessible(self):
        for product in ['far', 'aim']:
            for filename in ['', 'manifest.webmanifest', 'service-worker.js']:
                for origin in [None, f'https://{CHARTS}']:
                    for method in ['GET', 'HEAD']:
                        with self.subTest(product=product, filename=filename, origin=origin, method=method):
                            headers = {} if origin is None else {'Origin': origin}
                            self.read(f'/{product}/{filename}', method=method, domain=CHARTS, headers=headers)
                self.read(f'/{product}/{filename}', 403, domain=CHARTS,
                          headers={'Origin': 'https://untrusted.example'})
        # The chart host may also read its own data with an explicit Origin.
        self.read('/charts/cycles.json', domain=CHARTS, headers={'Origin': f'https://{CHARTS}'})


unittest.main(argv=[__file__], verbosity=2)
