#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test Amap Web Service V3/V4/V5 basic APIs with the Web-service key found in
~/.claude.json (mcpServers.amap-maps). Writes raw responses to tests/raw/ and
prints a compact capability summary table.

These are the endpoints we can test without a doc lookup (well-known shapes):
  geocode / regeocode / direction(walking,driving-v3,transit) /
  bicycling(v4) / driving-v5(newroute) / district / ip / convert / staticmap
"""
import json, urllib.request, urllib.parse, urllib.error, time
from pathlib import Path

KEY = json.load(open('/Users/evanpansmac/.claude.json'))['mcpServers']['amap-maps']['url'].split('key=')[1]
BASE = 'https://restapi.amap.com'
KB = Path('/Users/evanpansmac/Desktop/Riddle_AnAgentBasedTravelNotebook/KB/amap-webservice')
RAW = KB / 'tests' / 'raw'
RAW.mkdir(parents=True, exist_ok=True)

PKU   = '116.310918,39.992873'   # 北京大学
DARONG= '116.314985,39.980177'   # 中关村大融城(东区)

def call(path, params):
    p = dict(params); p['key'] = KEY
    url = BASE + path + '?' + urllib.parse.urlencode(p)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = r.read()
        ctype = r.headers.get('Content-Type', '')
        try:
            j = json.loads(data); jtype = 'json'
        except Exception:
            j = None; jtype = 'binary'
        return {'url': url, 'http': r.status, 'ctype': ctype, 'bytes': len(data),
                'json': j, 'jtype': jtype, 'raw': data}
    except urllib.error.HTTPError as e:
        return {'url': url, 'http': e.code, 'bytes': 0, 'json': {'httperr': str(e)}, 'jtype': 'err'}
    except Exception as e:
        return {'url': url, 'http': 0, 'bytes': 0, 'json': {'err': str(e)}, 'jtype': 'err'}

TESTS = [
    ('geocode',            '/v3/geocode/geo',                {'address': '北京大学'}),
    ('regeocode',          '/v3/geocode/regeo',              {'location': PKU}),
    ('direction-walking',  '/v3/direction/walking',          {'origin': PKU, 'destination': DARONG}),
    ('direction-driving-v3','/v3/direction/driving',         {'origin': PKU, 'destination': DARONG}),
    ('direction-transit',  '/v3/direction/transit/integrated',{'origin': PKU, 'destination': DARONG, 'city': '北京', 'cityd': '北京'}),
    ('direction-bicycling-v4','/v4/direction/bicycling',     {'origin': PKU, 'destination': DARONG}),
    ('driving-v5-newroute','/v5/direction/driving',          {'origin': PKU, 'destination': DARONG}),
    ('district',           '/v3/config/district',            {'keywords': '成都'}),
    ('ip-v3',              '/v3/ip',                         {'ip': '114.114.114.114'}),
    ('convert',            '/v3/assistant/coordinate/convert',{'locations': PKU, 'coordsys': 'gps'}),
    ('staticmap',          '/v3/staticmap',                  {'location': PKU, 'zoom': '15', 'size': '400*300'}),
]

def observe(res):
    j = res.get('json')
    if res['jtype'] == 'binary':
        magic = res['raw'][:4]
        kind = 'PNG' if magic == b'\x89PNG' else magic.hex()
        return f"binary {res['bytes']}B ({kind})"
    if not isinstance(j, dict):
        return ''
    if 'geocodes' in j:  return f"count={j.get('count')}"
    if 'regeocode' in j: return f"addr={(j['regeocode'].get('formatted_address') or '')[:18]}"
    if 'route' in j:
        paths = j['route'].get('paths') or []
        if paths:
            return f"paths={len(paths)} dist={paths[0].get('distance')} dur={paths[0].get('duration')}"
        return f"route keys={list(j['route'].keys())}"
    if 'districts' in j: return f"districts={len(j.get('districts') or [])}"
    if 'city' in j or 'province' in j: return f"ip-> {j.get('province','')}{j.get('city','')}"
    if 'locations' in j: return f"converted={j.get('locations')[:24]}"
    return 'keys=' + ','.join(list(j.keys())[:6])

rows = []
for name, path, params in TESTS:
    res = call(path, params)
    j = res.get('json')
    if res['jtype'] == 'json':
        (RAW / f'{name}.json').write_text(json.dumps(j, ensure_ascii=False, indent=2))
    elif res['jtype'] == 'binary':
        (RAW / f'{name}.bin').write_bytes(res['raw'])
        if res['raw'][:4] == b'\x89PNG':
            (RAW / f'{name}.png').write_bytes(res['raw'])
    infocode = (j or {}).get('infocode', '-') if isinstance(j, dict) else '-'
    info = (j or {}).get('info', '-') if isinstance(j, dict) else '-'
    status = (j or {}).get('status', '-') if isinstance(j, dict) else '-'
    rows.append((name, res['http'], status, infocode, info, res['bytes'], observe(res)))
    time.sleep(0.25)

print(f"\n{'API':<22}{'http':<5}{'stat':<5}{'infocode':<8}{'info':<8}{'bytes':<7} observation")
print('-' * 104)
for r in rows:
    print(f"{r[0]:<22}{str(r[1]):<5}{str(r[2]):<5}{str(r[3]):<8}{str(r[4])[:6]:<8}{r[5]:<7} {r[6]}")
print(f"\nRaw JSON/binary saved to: {RAW}")
