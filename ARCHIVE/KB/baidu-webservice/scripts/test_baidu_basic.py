#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test Baidu LBS Web Service APIs with BAIDU_WEB_SERVICE_AK from project .env.
Mirrors KB/amap-webservice/scripts/test_v3_basic.py: raw responses saved to
tests/raw/, compact capability summary printed.

Coverage (对标高德 KB 能力矩阵):
  geocoding / reverse_geocoding / place-search / direction(driving,walking,
  riding,transit-same-city) / transit-intercity-TRAIN / transit-intercity-FLIGHT /
  weather / region(district) / ip / geoconv / staticmap

注意：百度经纬度顺序是 纬度,经度（lat,lng），与高德的 经度,纬度 相反。
"""
import json, urllib.request, urllib.parse, urllib.error, time
from pathlib import Path

ROOT = Path('/Users/evanpansmac/Desktop/Riddle_AnAgentBasedTravelNotebook')
AK = None
for line in (ROOT / '.env').read_text().splitlines():
    if line.startswith('BAIDU_WEB_SERVICE_AK='):
        AK = line.split('=', 1)[1].strip()
assert AK, 'BAIDU_WEB_SERVICE_AK not found in .env'

BASE = 'https://api.map.baidu.com'
KB = ROOT / 'KB' / 'baidu-webservice'
RAW = KB / 'tests' / 'raw'
RAW.mkdir(parents=True, exist_ok=True)

# BD09LL 坐标（百度系，lat,lng）
TAM   = '39.9087,116.3975'    # 天安门
PKU   = '39.992874,116.316622'# 北京大学(近北大东门)
BJN   = '39.8650,116.3785'    # 北京南站
CD_E  = '30.6305,104.1406'    # 成都东站
CD    = '30.5728,104.0668'    # 成都市中心(天府广场附近)

def call(name, path, params):
    p = dict(params); p['ak'] = AK; p.setdefault('output', 'json')
    url = BASE + path + '?' + urllib.parse.urlencode(p)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = r.read()
        try:
            j = json.loads(data); jtype = 'json'
        except Exception:
            j = None; jtype = 'binary'
        (RAW / f'{name}.json' if jtype == 'json' else RAW / f'{name}.bin').write_bytes(data)
        return {'url': url, 'http': r.status, 'bytes': len(data), 'json': j, 'jtype': jtype, 'raw': data}
    except urllib.error.HTTPError as e:
        return {'url': url, 'http': e.code, 'bytes': 0, 'json': {'httperr': str(e)}, 'jtype': 'err'}
    except Exception as e:
        return {'url': url, 'http': 0, 'bytes': 0, 'json': {'err': str(e)}, 'jtype': 'err'}

TESTS = [
    ('geocoding',           '/geocoding/v3/',           {'address': '北京大学', 'city': '北京市'}),
    ('reverse-geocoding',   '/reverse_geocoding/v3/',   {'location': PKU}),
    ('place-search-v3',     '/place/v3/region',          {'query': '成都东站', 'region': '成都市'}),
    ('place-search-around', '/place/v3/around',           {'query': '火锅', 'location': CD, 'radius': '2000'}),
    ('direction-walking',   '/direction/v2/walking',   {'origin': TAM, 'destination': PKU}),
    ('direction-riding',    '/direction/v2/riding',     {'origin': TAM, 'destination': PKU}),
    ('direction-driving',   '/direction/v2/driving',   {'origin': TAM, 'destination': PKU}),
    ('transit-city',        '/direction/v2/transit',   {'origin': TAM, 'destination': PKU}),
    # 跨城：北京南站 → 成都东站，火车优先
    ('transit-train',       '/direction/v2/transit',   {'origin': BJN, 'destination': CD_E, 'trans_type_intercity': '0'}),
    # 跨城：北京(天安门) → 成都(天府广场)，飞机优先
    ('transit-flight',      '/direction/v2/transit',   {'origin': TAM, 'destination': CD, 'trans_type_intercity': '1'}),
    # 跨城：gcj02 坐标直接输入（验证高德坐标免转换兼容）
    ('transit-train-gcj02', '/direction/v2/transit',   {'origin': BJN, 'destination': CD_E, 'trans_type_intercity': '0', 'coord_type': 'gcj02'}),
    ('weather',             '/weather/v1/',             {'district_id': '510100', 'data_type': 'all'}),
    ('district-region',     '/api_region_search/v1/',   {'keyword': '成都', 'sub_admin': '0', 'extensions_code': '1'}),
    ('ip-locate',           '/location/ip',             {'ip': '110.84.0.1', 'co': ''}),
    ('geoconv',             '/geoconv/v1/',             {'coords': '116.310918,39.992873', 'from': '3', 'to': '6'}),
    ('staticmap',           '/staticimage/v2',          {'center': '116.3975,39.9087', 'zoom': '13', 'width': '400', 'height': '300'}),
]

def brief(name, res):
    j = res.get('json') or {}
    if res['jtype'] == 'binary':
        return f"{name:22s} HTTP {res['http']}  binary({res['bytes']}B) magic={res['raw'][:4]!r}"
    if res['jtype'] == 'err':
        return f"{name:22s} ERROR http={res['http']} {json.dumps(j, ensure_ascii=False)[:120]}"
    status = j.get('status', '?')
    msg = j.get('message', '')
    extra = ''
    if name.startswith('geocoding'):
        loc = (j.get('result') or {}).get('location') or {}
        extra = f" -> {loc.get('lat')},{loc.get('lng')} level={j.get('result',{}).get('level')}"
    if name == 'reverse-geocoding':
        faddr = (j.get('result') or {}).get('formatted_address', '')
        extra = f" -> {faddr}"
    if name.startswith('place-search'):
        res_list = (j.get('results') or [])
        extra = f" -> {len(res_list)} results, first={res_list[0].get('name') if res_list else None} uid={res_list[0].get('uid') if res_list else None}"
    if name.startswith('direction-'):
        rts = ((j.get('result') or {}).get('routes')) or []
        r0 = rts[0] if rts else {}
        extra = f" -> {len(rts)} routes, dist={r0.get('distance')}m dur={r0.get('duration')}s steps={len(r0.get('steps',[]))}"
    if name.startswith('transit'):
        rts = ((j.get('result') or {}).get('routes')) or []
        if rts:
            r0 = rts[0]
            segs = []
            for st in r0.get('steps', []):
                # step 可能是 dict（每键一类交通段）或 list，先归一成 dict 列表
                st_list = st if isinstance(st, list) else [st]
                for stt in st_list:
                    if not isinstance(stt, dict):
                        continue
                    for k, v in stt.items():
                        if not isinstance(v, list):
                            continue
                        for it in v:
                            if not isinstance(it, dict):
                                continue
                            bus = it.get('bus') or it.get('railway') or it.get('flight') or it.get('coach') or {}
                            nm = bus.get('name') or bus.get('line_name') or ''
                            dep = ((bus.get('departure_stop') or {}) or {}).get('name', '')
                            typ = bus.get('type', '')
                            has_poly = bool(it.get('path'))
                            segs.append(f"{k}{'·'+str(typ) if typ!='' else ''}{'·'+nm if nm else ''}{'('+dep+')' if dep else ''}{'✓path' if has_poly else '✗path'}")
            extra = f" -> {len(rts)} routes, dist={r0.get('distance')}m dur={r0.get('duration')}s, segments: " + ' | '.join(segs[:10])
        else:
            extra = f" -> no routes, message={msg!r}, result={str(j.get('result'))[:100]}"
    if name == 'weather':
        now = ((j.get('result') or {}).get('now')) or {}
        extra = f" -> {now.get('text')} {now.get('temp')}℃ forecasts={len((j.get('result') or {}).get('forecasts') or [])}"
    if name == 'district-region':
        rs = (j.get('results') or [])
        extra = f" -> {len(rs)} regions, first={rs[0] if rs else None}"
    if name == 'ip-locate':
        ct = (j.get('content') or {}).get('address_detail') or {}
        extra = f" -> {ct.get('city')},{ct.get('province')}"
    if name == 'geoconv':
        rs = j.get('result') or []
        extra = f" -> {rs[:1]}"
    return f"{name:22s} HTTP {res['http']} status={status} {msg[:40]}{extra}"

print(f"AK=...{AK[-6:]}  (guard: full key never printed)\n")
for name, path, params in TESTS:
    res = call(name, path, params)
    print(brief(name, res))
    print(f"    url={res['url'][:160]}")
    time.sleep(0.4)
print("\nraw responses saved to", RAW)
