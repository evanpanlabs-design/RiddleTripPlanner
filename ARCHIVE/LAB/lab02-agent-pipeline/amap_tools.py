"""高德 Web Service 工具层（SPEC §7）。

约束（LAB01/KB）：
- 跨城仅驾车+测地线；火车/飞机无源 → Edge 标 empty/user_filled。
- 缓存策略（S2）：新查询覆盖旧查询（last-write-wins，记 fetched_at）；惰性刷新由调用方控制。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from pathlib import Path

import requests

BASE = "https://restapi.amap.com"
CACHE_DIR = Path(__file__).parent / "cache"

# 个人 web service key QPS 限制（实测 CUQPS_HAS_EXCEEDED_THE_LIMIT），串行节流
_LAST_CALL = [0.0]
_MIN_INTERVAL = 0.4


def _key() -> str:
    return os.environ["AMAP_WEB_SERVICE_KEY"]


def _cache_get(ns: str, payload: dict, ttl_days: int = 7):
    CACHE_DIR.mkdir(exist_ok=True)
    h = hashlib.md5(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    f = CACHE_DIR / f"{ns}_{h}.json"
    if f.exists():
        data = json.loads(f.read_text())
        age_days = (time.time() - data["fetched_at"]) / 86400
        if age_days <= ttl_days:
            return data["result"]
    return None


def _cache_put(ns: str, payload: dict, result):
    h = hashlib.md5(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    f = CACHE_DIR / f"{ns}_{h}.json"
    f.write_text(json.dumps({"fetched_at": time.time(), "result": result}, ensure_ascii=False))


def _get(path: str, params: dict, _retries: int = 2) -> dict:
    params = dict(params); params["key"] = _key()
    for attempt in range(_retries + 1):
        wait = _MIN_INTERVAL - (time.time() - _LAST_CALL[0])
        if wait > 0:
            time.sleep(wait)
        _LAST_CALL[0] = time.time()
        r = requests.get(f"{BASE}{path}", params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        if str(data.get("status")) == "1":
            return data
        if data.get("infocode") == "10021" and attempt < _retries:  # QPS 超限 → 退避重试
            time.sleep(1.2 * (attempt + 1))
            continue
        raise RuntimeError(f"amap error: {data.get('info')} ({data.get('infocode')})")
    return data


def search_poi(name: str, city: str | None = None) -> dict | None:
    """POI 搜索，返回标准化 Node 字段。找不到返回 None。"""
    payload = {"kw": name, "city": city}
    cached = _cache_get("poi", payload)
    if cached is not None:
        return cached
    params = {"keywords": name, "offset": 3, "page": 1, "extensions": "all"}
    if city:
        params["city"] = city; params["citylimit"] = "true"
    data = _get("/v3/place/text", params)
    pois = data.get("pois", [])
    result = None
    if pois:
        p = pois[0]
        lng, lat = (p.get("location") or ",").split(",")[:2] if p.get("location") else (None, None)
        result = {
            "amap_poi_id": p.get("id"),
            "name": p.get("name"),
            "category_tags": (p.get("type") or "").split(";"),
            "geo": {"lng": float(lng), "lat": float(lat)} if lat else None,
            "city": p.get("cityname"),
            "address": p.get("address") if isinstance(p.get("address"), str) else "",
            "opening_hours": None,   # v3 无可靠营业时间字段 → None（V3 转 warn）
            "fetched_at": time.time(),
        }
    _cache_put("poi", payload, result)
    return result


def driving_route(from_geo: dict, to_geo: dict) -> dict | None:
    """驾车路线：{distance_m, duration_s, polyline}。"""
    payload = {"f": from_geo, "t": to_geo}
    cached = _cache_get("drive", payload)
    if cached is not None:
        return cached
    origin = f"{from_geo['lng']},{from_geo['lat']}"
    dest = f"{to_geo['lng']},{to_geo['lat']}"
    data = _get("/v3/direction/driving", {"origin": origin, "destination": dest, "strategy": 0})
    paths = (data.get("route") or {}).get("paths") or []
    result = None
    if paths:
        p = paths[0]
        polyline = []
        for step in p.get("steps", [])[:50]:
            for pt in (step.get("polyline") or "").split(";"):
                if pt:
                    lng, lat = pt.split(",")
                    polyline.append([float(lng), float(lat)])
        result = {"distance_m": float(p.get("distance", 0)),
                  "duration_s": float(p.get("duration", 0)),
                  "polyline": polyline}
    _cache_put("drive", payload, result)
    return result


def geodesic_m(from_geo: dict, to_geo: dict) -> float:
    """测地线距离（大圆近似），无源方式的 Edge 兜底。"""
    r = 6371000.0
    lat1, lon1 = math.radians(from_geo["lat"]), math.radians(from_geo["lng"])
    lat2, lon2 = math.radians(to_geo["lat"]), math.radians(to_geo["lng"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_edge(from_node, to_node, mode: str):
    """按 SPEC §7 规则构造 Edge 数据。返回 dict(distance_m, duration_s, data_source, geometry)。"""
    from models import AMAP_UNSUPPORTED_MODES
    if mode in AMAP_UNSUPPORTED_MODES or not from_node.geo or not to_node.geo:
        return {"distance_m": None, "duration_s": None, "data_source": "empty", "geometry": []}
    if mode == "drive":
        route = driving_route(from_node.geo, to_node.geo)
        if route:
            return {"distance_m": route["distance_m"], "duration_s": route["duration_s"],
                    "data_source": "amap_drive", "geometry": route["polyline"]}
    # 其余方式或无驾车结果 → 测地线兜底（有距离无耗时）
    return {"distance_m": geodesic_m(from_node.geo, to_node.geo),
            "duration_s": None, "data_source": "amap_geodesic", "geometry": []}
