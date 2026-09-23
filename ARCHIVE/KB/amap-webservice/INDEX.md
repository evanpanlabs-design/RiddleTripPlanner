# 高德 Web Service API 能力边界索引

> 本索引自 2026-09-21 实测整理。测试 Key 为存于 `~/.claude.json` MCP 配置中的 **Web服务 Key**(32 位)。`docs/raw/` 存 22 篇官方文档 HTML 原文;`tests/raw/` 存 37 个真实接口响应;`scripts/` 存可复跑测试脚本。

---

## 0. 资源选择结论

| 资源 | 凭证 | 用途 | 本批文档是否涉及 |
|---|---|---|---|
| **Web服务** | 仅 Key | `restapi.amap.com` REST 调用 | ✅ **用这个** |
| Web端 | Key + 安全密钥 | 浏览器 JS API(`webapi.amap.com`) | ❌ 不涉及 |

文档全部位于 `lbs.amap.com/api/webservice/` 下(`/api/` = V3 基础,`/api-advanced/` = V2/V5 高级)。**测试一律用 Web服务 Key。**

---

## 1. 能力总览矩阵

图例:✅ 可用 / 🔒 权限不足(10012,需更高认证) / ⚠️ 需特殊数据 / ❌ 不支持

### 路径规划(direction / newroute / advanced-path)
| API | 端点 | 状态 | 说明 |
|---|---|---|---|
| 步行 V3 | `/v3/direction/walking` | ✅ | 每步带 `polyline` |
| 驾车 V3 | `/v3/direction/driving` | ✅ | 每步带 `polyline`+`tmcs`+`cities` |
| 公交 V3 | `/v3/direction/transit/integrated` | ✅ | intercity 已弱化(实测北京→成都返 0 条) |
| 骑行 V4 | `/v4/direction/bicycling` | ✅ | V4 外壳(`errcode/data`),带 `polyline` |
| 驾车 V5 | `/v5/direction/driving` | ✅ | 须 `show_fields=cost` 才给 duration;`polylines` 给折线 |
| 步行 V5 | `/v5/direction/walking` | ✅ | `show_fields=cost` |
| 骑行 V5 | `/v5/direction/bicycling` | ✅ | |
| 电动车 V5 | `/v5/direction/electrobike` | ✅ | |
| **跨城公交 V5** | `/v5/direction/transit/integrated` | ✅ | **必填 `city1`/`city2`(citycode,如 010/028)+ origin+destination**;支持 `nightflag`/`date`/`time`/`strategy` |
| ETA 驾车 V4 | `/v4/etd/driving` | 🔒 | `10012 INSUFFICIENT_PRIVILEGES` |

### 检索(search / newpoisearch / inputtips / geohub)
| API | 端点 | 状态 | 说明 |
|---|---|---|---|
| 关键词 V3 | `/v3/place/text` | ✅ | 默认返 20 条 |
| 周边搜 V3 | `/v3/place/around` | ✅ | |
| 多边形 V3 | `/v3/place/polygon` | ✅ | |
| POI 详情 V3 | `/v3/place/detail` | ✅ | |
| 文本搜 V5 | `/v5/place/text` | ✅ | `show_fields=children,business` |
| 周边搜 V5 | `/v5/place/around` | ✅ | |
| 多边形 V5 | `/v5/place/polygon` | ✅ | |
| 详情 V5 | `/v5/place/detail` | ✅ | |
| 输入提示 | `/v3/assistant/inputtips` | ✅ | |
| AOI 轮廓 | `/v5/aoi/polyline` | 🔒 | `10012`,建筑/区域面轮廓,需认证 |
| GeoHub 地点 | `/rest/lbs/geohub/place/text` | ⚠️ | 需自建 `dataset_id`,否则 `20000 INVALID_PARAMS` |

### 地理编码 / 行政区 / 坐标
| API | 端点 | 状态 | 说明 |
|---|---|---|---|
| 地理编码 | `/v3/geocode/geo` | ✅ | |
| 逆地理 | `/v3/geocode/regeo` | ✅ | |
| 行政区 | `/v3/config/district` | ✅ | |
| 坐标转换 | `/v3/assistant/coordinate/convert` | ✅ | `coordsys=gps` 等 |

### 天气 / 交通
| API | 端点 | 状态 | 说明 |
|---|---|---|---|
| 天气 | `/v3/weather/weatherInfo` | ✅ | `extensions=base`(实况)/`all`(预报) |
| 交通态势-圆形 | `/v3/traffic/status/circle` | ✅ | |
| 交通态势-矩形 | `/v3/traffic/status/rectangle` | ✅ | |
| 交通态势-道路 | `/v3/traffic/status/road` | ✅ | |
| 交通事件 | (无端点) | ❌ | 文档无公开 REST 端点,疑企业版 |

### 公交 / IP / 静态图 / 轨迹 / 定位
| API | 端点 | 状态 | 说明 |
|---|---|---|---|
| 公交线路 | `/v3/bus/linename` | ✅ | 城市公交元数据(线/站),非跨城 |
| 公交站点 | `/v3/bus/stopname` | ✅ | |
| IP 定位 V3 | `/v3/ip` | ✅ | 真实 ISP IP 可定位;`114.114.114.114` 等 anycast 返空 |
| IP 定位 V5 | `/v5/ip/location` | 🔒 | `10012` |
| 静态地图 | `/v3/staticmap` | ✅ | 返回 PNG |
| 轨迹纠偏 | `/v4/grasproad/driving` POST | ⚠️ | Key 有权限;需有效连续 GPS 轨迹,测试数据被引擎拒(`30001`) |
| 硬件定位 | `/v5/position/IoT` POST | 🔒 | `10012`,需基站/ wifi 真实数据 |

---

## 2. 八条关键能力边界(本研究最重要结论)

1. **polyline 在 REST 接口里是齐全的**。V3/V4/V5 direction 的每一步 `step.polyline` 都返回 `lng,lat;lng,lat;…`。之前用 MCP 时被裁掉、导致无法画贴路折线——**绕过 MCP 直接调 REST 即解决**。V5 驾车需额外 `show_fields=polylines`。

2. **V5 的 `show_fields` 是关键字段开关**。不传则只有 `distance/steps`;`cost`→`{duration,tolls,toll_distance,traffic_lights}`、`polylines`、`tmcs`、`cities`、`restriction` 按需逗号拼接。**取值是 `cost` 不是 `cars`**(踩过坑)。

3. **V5 跨城公交的必填参数与 V3 不同**:用 `city1`+`city2`(且**只认 citycode** 如 `010`/`028`,不认城市名),不是 V3 的 `city`/`cityd`。少传即 `20001 MISSING_REQUIRED_PARAMS`。还支持 `nightflag`(夜班车)、`date`、`time`、`strategy`(0-8)、`AlternativeRoute`。**这正是查"夜晚出发火车"的正确接口。**

4. **没有任何 API 返回航班信息**。transit 引擎只产出 `walking` / `bus` / `railway` 三类段。文档中"30 飞机经济舱/31 飞机商务舱"仅是 `cost` 费用系数表的计算码,**不代表会返回航班段**(实测响应不含 flight/air/飞机/航班)。航班要靠航旅/OTA 类接口。

5. **响应外壳有三种,解析需分别处理**:
   - V3/V5:`status` / `info` / `infocode`(10000=OK)
   - V4:`errcode`(0=OK)/ `errmsg` / `data`
   - 静态地图:二进制 PNG

6. **四个接口权限门槛 `10012 INSUFFICIENT_PRIVILEGES`**(当前 Key 不可用,需在控制台开通/认证):`/v5/aoi/polyline`、`/v5/ip/location`、`/v4/etd/driving`(ETA)、`/v5/position/IoT`(硬件定位)。

7. **GeoHub 是"自带数据集"检索**:必须在 GeoHub 控制台预先建 `dataset_id`,接口才能查;空查 → `20000 INVALID_PARAMS`。不是开箱即用的公开 POI。

8. **`traffic-incident`(交通事件)文档里没有公开 REST 端点**,正则抽取为空——大概率是面向企业/认证客户的能力,普通 Web服务 Key 拿不到。

---

## 3. 文件清单

```
KB/amap-webservice/
├── INDEX.md                  # 本文件(能力边界索引)
├── docs/
│   ├── ENDPOINTS.md          # 从 22 篇 HTML 自动提取的端点清单
│   └── raw/*.html (22)       # 官方文档原文归档
├── tests/
│   ├── SUMMARY.md            # 37 条测试结果汇总表
│   └── raw/*.json|png (37)   # 真实接口响应留档
└── scripts/
    ├── test_v3_basic.py      # V3/V4/V5 基础接口测试,可复跑
    └── test_v2_advanced.py   # V2/V5 高级接口测试,可复跑
```

复跑:`python3 KB/amap-webservice/scripts/test_v3_basic.py` / `test_v2_advanced.py`(自动从 `~/.claude.json` 读 Key)。
