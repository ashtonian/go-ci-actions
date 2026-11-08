"""Native authorization probes: no fabricated token or local authorization stub."""
import importlib.util
import os
from pathlib import Path
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('artifact', Path(__file__).parents[1] / 'lib/artifact.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
s = a.Store()
probes = [
    ('write an unretained path', 'PUT', f'data/999d/{s.repository_id}/{s.run_id}/{s.attempt}/probe.zip', None),
    ('write another attempt', 'PUT', f'metadata/{s.repository_id}/{s.run_id}/999/probe.json', None),
    ('delete an object', 'DELETE', f'metadata/{s.repository_id}/{s.run_id}/{s.attempt}/probe.json', None),
    ('write another repository', 'PUT', f'metadata/1/{s.run_id}/{s.attempt}/probe.json', None),
    ('write another run', 'PUT', f'metadata/{s.repository_id}/1/{s.attempt}/probe.json', None),
    ('read another repository', 'GET', 'metadata/1/1/1/probe.json', None),
    ('list another repository', 'GET', '', {'list-type':'2', 'prefix':'metadata/1/'}),
    ('list the bucket root', 'GET', '', {'list-type':'2'}),
]
for label, method, key, query in probes:
    try:
        s.request(method, key, query=query, body=b'{}' if method == 'PUT' else None)
    except urllib.error.HTTPError as exc:
        if exc.code != 403:
            raise
        print(label + ': denied')
    else:
        raise SystemExit(label + ': unexpectedly permitted')
try:
    urllib.request.urlopen(s.endpoint + '/' + s.bucket + '/?list-type=2', timeout=15)
except urllib.error.HTTPError as exc:
    if exc.code != 403:
        raise
    print('anonymous access: denied')
else:
    raise SystemExit('anonymous access unexpectedly permitted')
items = s.manifests()
assert {item['name'] for item in items} == {'round-trip', 'second-result'}, items
assert {item['retention_days'] for item in items} == {1, 7}, items
print('native manifest reads: passed')
