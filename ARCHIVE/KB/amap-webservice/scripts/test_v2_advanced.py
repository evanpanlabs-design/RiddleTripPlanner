#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test Amap Web Service V2-advanced / V3 / V4 / V5 APIs. Endpoint paths were
extracted from the archived doc HTML (see docs/raw/). Full responses are saved
to tests/raw/; a compact capability table is printed.

Highlights probed:
  - V5 driving with show_fields=cost,polylines,tmcs,cities  (does duration/polyline appear?)
  - V5 intercity transit Beijing->Chengdu  (does it return flights? trains?)
  - POST APIs: grasproad / hardware-location(pinpoint) / the param gate they enforce
  - GeoHub place/text (requires dataset_id) -> expected to fail, documented
  - AOI polyline (building outline) for map drawing
"""
import json, urllib.request, urllib.parse, urllib.error, time
from pathlib import Path

KEY = json.load(open('/Users/evanpansmac/.claude.json'))['mcpServers']['amap-maps']['url'].split('key=')[1]
BASE = 'https://restapi.amap.com'
KB = Path('/Users/evanpansmac/Desktop/Riddle_AnAgentBasedTravelNotebook/KB/amap-webservice')
RAW = KB / 'tests' / 'raw'
RAW.mkdir(parents=True, exist_ok=True)

PKU   = '116.310918,39.992873'   # 北京大学
DARONG= '116.314985,39.980177'   # 中关村大融城
BJ_WEST = '116.322033,39.894912' # 北京西站
CD_EAST = '104.140947,30.628779' # 成都东站
DARONG_POIID = 'B0LG7ZMH4E'      # 中关村大融城(东区)

def req(path, params, method='GET', body=None):
    p = dict(params); p['key'] = KEY
    url = BASE + path + ('?' + urllib.parse.urlencode(p) if method == 'GET' else '')
    try:
        if method == 'GET':
            r = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
        else:
            q = '?' + urllib.parse.urlencode({'key': KEY})
            url = BASE + path + q
            data = json.dumps(body).encode() if body else None
            r = urllib.request.Request(url, data=data, method='POST',
                                       headers={'User-Agent': 'curl/8', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(r, timeout=25) as resp:
            data = resp.read()
        try: j = json.loads(data); jt = 'json'
        except Exception: j = None; jt = 'bin'
        return {'url': url, 'http': resp.status, 'bytes': len(data), 'json': j, 'jtype': jt, 'raw': data}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='ignore')[:200]
        return {'url': url, 'http': e.code, 'bytes': 0, 'json': {'httperr': str(e), 'body': body}, 'jtype': 'err'}
    except Exception as e:
        return {'url': url, 'http': 0, 'bytes': 0, 'json': {'err': str(e)}, 'jtype': 'err'}

def save(name, res):
    if res['jtype'] == 'json':
        (RAW / f'{name}.json').write_text(json.dumps(res['json'], ensure_ascii=False, indent=2))
    elif res['jtype'] == 'bin':
        (RAW / f'{name}.bin').write_bytes(res['raw'])

GET_Tests = [
  # --- newpoisearch V5 ---
  ('v5-place-text',       '/v5/place/text',        {'keywords': '北京大学', 'region': '北京', 'show_fields': 'children,business'}),
  ('v5-place-around',     '/v5/place/around',      {'location': PKU, 'keywords': '咖啡', 'radius': '1000', 'show_fields': 'business'}),
  ('v5-place-polygon',    '/v5/place/polygon',     {'polygon': '116.30,39.99;116.32,39.99;116.31,39.98', 'keywords': '餐厅'}),
  # --- search V3 ---
  ('v3-place-text',       '/v3/place/text',        {'keywords': '中关村大融城', 'city': '北京'}),
  ('v3-place-around',     '/v3/place/around',      {'location': PKU, 'keywords': '餐厅', 'radius': '1000'}),
  # --- aoi polyline (building outline) ---
  ('v5-aoi-polyline',     '/v5/aoi/polyline',      {'poiid': DARONG_POIID}),
  # --- inputtips ---
  ('v3-inputtips',        '/v3/assistant/inputtips',{'keywords': '中关村大融城', 'city': '北京'}),
  # --- weather ---
  ('v3-weather-all',      '/v3/weather/weatherInfo',{'city': '北京', 'extensions': 'all'}),
  ('v3-weather-base',     '/v3/weather/weatherInfo',{'city': '北京', 'extensions': 'base'}),
  # --- ip v5 ---
  ('v5-ip-location',      '/v5/ip/location',       {'ip': '220.181.38.148'}),
  # --- traffic status ---
  ('v3-traffic-circle',   '/v3/traffic/status/circle',     {'location': PKU, 'radius': '1000', 'level': 5}),
  ('v3-traffic-rectangle', '/v3/traffic/status/rectangle', {'rectangle': '116.30,39.98;116.33,40.00', 'level': 5}),
  ('v3-traffic-road',     '/v3/traffic/status/road',       {'name': '中关村大街', 'city': '北京', 'level': 5}),
  # --- bus line/stop metadata (city bus, NOT intercity) ---
  ('v3-bus-linename',     '/v3/bus/linename',      {'city': '北京', 'keywords': '320'}),
  ('v3-bus-stopname',     '/v3/bus/stopname',      {'city': '北京', 'keywords': '中关村'}),
  # --- newroute V5 ---
  ('v5-walking',          '/v5/direction/walking',  {'origin': PKU, 'destination': DARONG, 'show_fields': 'cost'}),
  ('v5-electrobike',      '/v5/direction/electrobike', {'origin': PKU, 'destination': DARONG, 'show_fields': 'cost'}),
  ('v5-driving-cost',     '/v5/direction/driving',  {'origin': PKU, 'destination': DARONG, 'show_fields': 'cost,polylines,tmcs,cities'}),
  ('v5-transit-intercity', '/v5/direction/transit/integrated', {'origin': BJ_WEST, 'destination': CD_EAST, 'city': '北京', 'cityd': '成都', 'show_fields': 'cost'}),
  ('v5-bicycling',        '/v5/direction/bicycling',{'origin': PKU, 'destination': DARONG, 'show_fields': 'cost'}),
  # --- advanced path: ETA driving ---
  ('v4-etd-driving',      '/v4/etd/driving',        {'origin': PKU, 'destination': DARONG}),
  # --- geohub place (requires dataset_id) ---
  ('geohub-place-text',   '/rest/lbs/geohub/place/text', {'keywords': '北京大学', 'condition_type': '0'}),
]

def describe(name, res):
    j = res.get('json')
    if not isinstance(j, dict): return f"bin {res['bytes']}B" if res.get('jtype')=='bin' else ''
    # V5/V4 use errcode envelope sometimes
    if 'errcode' in j and 'infocode' not in j:
        code = j.get('errcode'); msg = j.get('errmsg')
        data = j.get('data')
        hint = ''
        if isinstance(data, dict) and 'paths' in data: hint=f"paths={len(data['paths'])}"
        elif isinstance(data, list): hint=f"list={len(data)}"
        return f"[V4env errcode={code} {msg}] {hint}"
    status = j.get('status', '-'); ic = j.get('infocode', '-'); info = j.get('info', '-')
    hint = ''
    if 'pois' in j: hint = f"pois={len(j['pois'])}"
    elif 'tips' in j: hint = f"tips={len(j['tips']) if isinstance(j['tips'],list) else 'has'}"
    elif 'forecasts' in j: hint = f"forecasts={len(j['forecasts'])}"
    elif 'lives' in j: hint = f"lives={len(j['lives'])}"
    elif 'trafficinfo' in j: hint = "has trafficinfo"
    elif 'data' in j and isinstance(j['data'], dict):
        d=j['data']
        if 'paths' in d: hint=f"paths={len(d['paths'])}"
        elif 'detail' in d: hint="has detail"
        elif 'route' in d and 'transits' in d.get('route',{}): hint=f"transits={len(d['route']['transits'])}"
        else: hint='keys='+','.join(list(d.keys())[:5])
    elif 'route' in j:
        rt=j['route']
        if 'transits' in rt: hint=f"transits={len(rt['transits'])}"
        elif 'paths' in rt: hint=f"paths={len(rt['paths'])}"
    elif 'buslines' in j: hint = f"buslines={len(j['buslines'])}"
    return f"st={status} ic={ic} {info} | {hint}"

rows = []
for name, path, params in GET_Tests:
    res = req(path, params)
    save(name, res)
    j = res.get('json') or {}
    ic = j.get('infocode', j.get('errcode', '-')) if isinstance(j, dict) else '-'
    rows.append((name, res['http'], ic, res['bytes'], describe(name, res)))
    time.sleep(0.25)

# chained: v5-place-detail using a poi id from v5-place-text
detail_id = None
pt = (RAW / 'v5-place-text.json')
if pt.exists():
    pj = json.load(open(pt))
    pois = pj.get('pois') or []
    if pois: detail_id = pois[0].get('id') or pois[0].get('poi_id')
if detail_id:
    res = req('/v5/place/detail', {'id': detail_id, 'show_fields': 'business,children,photos'})
    save('v5-place-detail', res)
    j=res.get('json') or {}
    rows.append(('v5-place-detail', res['http'], j.get('infocode','-'), res['bytes'], describe('v5-place-detail', res)))

# --- POST APIs ---
# grasproad: JsonArray of {x,y,sp,ag,tm}
pts = [
  {"x":"116.310833","y":"39.992865","sp":5,"ag":0,"tm":1700000000000},
  {"x":"116.310859","y":"39.992635","sp":4,"ag":0,"tm":1700000005000},
  {"x":"116.310807","y":"39.992569","sp":4,"ag":0,"tm":1700000010000},
]
res = req('/v4/grasproad/driving', {}, method='POST', body=pts)
save('v4-grasproad', res)
j=res.get('json') or {}
rows.append(('v4-grasproad-POST', res['http'], j.get('errcode', j.get('infocode','-')), res['bytes'], describe('v4-grasproad', res)))

# hardware-location: minimal body to surface param gate
hw = {"accesstype":0,"bts":"460,0,4181,12345,-80","imei":"863648051234567","smac":"CC:B8:A8:AA:BB:CC"}
res = req('/v5/position/IoT', {}, method='POST', body=hw)
save('v5-position-iot', res)
j=res.get('json') or {}
rows.append(('v5-position-iot-POST', res['http'], j.get('errcode', j.get('infocode','-')), res['bytes'], describe('v5-position-iot', res)))

print(f"\n{'API':<24}{'http':<5}{'code':<7}{'bytes':<7} observation")
print('-' * 110)
for r in rows:
    print(f"{r[0]:<24}{str(r[1]):<5}{str(r[2]):<7}{r[3]:<7} {r[4]}")
print(f"\nRaw responses saved to: {RAW}")
