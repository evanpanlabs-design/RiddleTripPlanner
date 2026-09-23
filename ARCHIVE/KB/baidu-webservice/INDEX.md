# 百度地图 Web Service 能力边界索引（对标高德迁移评估）

> 2026-09-22 实测整理。测试 AK 为 `.env` 中的 `BAIDU_WEB_SERVICE_AK`（控制台 test1，服务端类型，IP 白名单已改 `0.0.0.0/0`）。`tests/raw/` 存 16 个真实接口响应；`scripts/test_baidu_basic.py` 可复跑。
> 浏览器端验证见 `LAB/lab03-baidu-transit-demo/`（JSAPI 4.0，AK 为 test2 `BAIDU_WEBJS_AK`）。

## 0. 迁移结论（TL;DR）

1. **覆盖性：通过**。高德 KB 能力矩阵中的全部日常能力（检索/编码/算路/天气/行政区/IP/静态图/坐标转换）百度均有对应接口，且 16 项实测全部 `status=0`。
2. **火车/飞机：通过（这是相对高德的重大增强）**。百度 Direction v2 transit 跨城模式原生返回**真实车次/航班**（G321、MU3526…），含完整门到门接驳（地铁/步行），每段带 `path` 折线可直接绘图。高德只能返回 railway 段、无航班。
3. JSAPI 4.0 浏览器端已实测加载成功，服务端返回的 BD09LL 折线原样绘制成功（火车 9 段、飞机 12 段、驾车 23 段）。

## 1. 能力对标矩阵（高德 → 百度）

图例：✅ 实测通过 / ⚠️ 有差异需注意

| 能力 | 高德端点 | 百度端点 | 实测 | 差异注意 |
|---|---|---|---|---|
| 地理编码 | `/v3/geocode/geo` | `/geocoding/v3/` | ✅ | 参数名 `address` 同 |
| 逆地理 | `/v3/geocode/regeo` | `/reverse_geocoding/v3/` | ✅ | |
| POI 城市检索 | `/v3/place/text` | `/place/v3/region` | ✅ | v3 用 `region`；旧版 `/place/v2/search` 仍可用 |
| POI 周边检索 | `/v3/place/around` | `/place/v3/around` | ✅ | |
| POI 详情 | `/v3/place/detail` | `/place/v2/detail`（uid） | 未测 | |
| 输入提示 | `/v3/assistant/inputtips` | `/place/v2/suggestion` | 未测 | |
| 步行算路 | `/v3/direction/walking` | `/direction/v2/walking` | ✅ | |
| 骑行算路 | `/v4/direction/bicycling` | `/direction/v2/riding` | ✅ | |
| 驾车算路 | `/v3/direction/driving` | `/direction/v2/driving` | ✅ | 支持备选路线/18 途经点/车牌限行规避，强于高德 V3 |
| 同城公交 | `/v3/direction/transit/integrated` | `/direction/v2/transit` | ✅ | |
| **跨城公交/火车/飞机** | `/v5/direction/transit/integrated`（仅公交+railway，无航班） | `/direction/v2/transit` + `trans_type_intercity`（0 火车/1 飞机/2 大巴） | ✅ | **百度完胜**：真实车次/航班号+时刻+票价 |
| 行政区划 | `/v3/config/district` | `/api_region_search/v1/` | ✅ | 返回字段是 `districts` 不是 `results` |
| 天气 | `/v3/weather/weatherInfo` | `/weather/v1/` | ✅ | 按区县 `district_id`（adcode），实测 7 天预报 |
| IP 定位 | `/v3/ip` | `/location/ip` | ✅ | |
| 坐标转换 | `/v3/assistant/coordinate/convert` | `/geoconv/v1/` | ✅ | from=3(gcj02)→to=6(bd09mc)；from=1 gps |
| 静态图 | `/v3/staticmap` | `/staticimage/v2` | ✅ | PNG |
| 交通态势 | `/v3/traffic/status/*` | `/traffic/v1/` + JSAPI 路况图层 | 未测 | 文档另有动态交通事件接口（高德没有公开版） |
| 轨迹纠偏 | `/v4/grasproad/driving` | 鹰眼轨迹 /trackrectify | 未测 | 百度归入鹰眼体系 |
| ETA/未来出行 | `/v4/etd/driving`(10012 无权限) | Direction v2 `departure_time`（付费） | — | 两家都要高级权限 |

## 2. 八条关键迁移注意点（对照高德踩坑记录）

1. **经纬度顺序相反**：百度请求参数是 `lat,lng`（纬度在前），与高德 `lng,lat` 相反；**但 transit/driving 返回的 `path` 是 `lng,lat`**（与高德 polyline 一致）。请求侧要翻转，返回侧不用。
2. **坐标系**：百度默认 BD09LL（高德是 GCJ02）。两条迁移路径：① 请求带 `coord_type=gcj02`、JSAPI 设 `BMap.coordType = BMAP_COORD_GCJ02`（已实测 transit 支持 gcj02 直传）；② MCP `map_geoconv` 或 `/geoconv/v1/` 批量转换。**数据库里已存的高德坐标建议一次性转成 BD09 落库**，或统一约定走 coordType 通道。
3. **响应外壳不同**：百度统一 `status`(0=OK)/`message`/`result`，比高德 V3/V4/V5 三种外壳简单；错误码如 `210` IP 白名单拒绝、`240` 服务未开通。
4. **AK 类型严格分家**：服务端 AK 只能调 REST（校验 IP 白名单，`0.0.0.0` 字面值=全拒，必须 `0.0.0.0/0` 或留空）；浏览器 AK 只能用于 JSAPI（校验 Referer，`*`=全放行），交叉使用报 240/210。
5. **transit steps 是二维数组**：`routes[].steps[i]` 为段数组，每段 `vehicle_info.type` 区分交通方式（1 火车、2 飞机、3 公交/地铁、5 步行），`detail.name` 即真实车次/航班号/线路名，`path` 折线、`instructions` 文案齐全。
6. **无 SN 需求**：AK 未启用 SN 校验时无需签名（高德 v2.0 JSAPI 必须配 securityJsCode，百度浏览器端无对应强制项，生产建议用 serviceHost 代理）。
7. **轻量版陷阱**：`/direction/v1/*`（DirectionLite）不支持跨城和火车/飞机，迁移代码必须用 Direction v2。
8. **配额模型不同**：百度按"服务×个人/企业认证"分级配额，控制台可看额度；高德 `10021` QPS 退避逻辑需替换为百度对应的限流处理（百度超限返回 status≠0 + message）。

## 3. MCP Server（对 Agent 项目的推荐接入方式）

- Streamable HTTP：`https://mcp.map.baidu.com/mcp?ak=<服务端AK>`（实测 initialize + tools/list 成功，`mcp-server-baidu-maps` v1.28）
- 14 个工具：`map_geocode` / `map_reverse_geocode` / `map_search_places` / `map_place_details` / `map_directions` / `map_directions_matrix` / `map_weather` / `map_ip_location` / `map_road_traffic` / `map_search_pro`（语义多维检索）/ `map_district_search` / `map_uri`（地图调起）/ **`map_mark`（旅游规划一键生成地图展示，官方旅行场景）** / `map_geoconv`（1=高德转百度）
- 对比结论：MCP 适合"给 Agent 的自然语言工具面"；`APP/src/tools/amap.ts` 这类程序化调用建议继续直连 REST（与高德 KB 结论"绕过 MCP 直调 REST"一致），MCP 可作为 Agent 侧的补充或 `map_mark` 的唯一通道。

## 4. 地图风格结论（2026-09-22 决策）

**项目采用标准底图，不做个性化定制。** 背景知识备查：

- 百度无高德式官方预设主题 ID（dark/light/grey 等），风格体系 = 底图类型（`setMapType`：标准 `BMAP_NORMAL_MAP` / 卫星 / 混合 / 地球）× 个性化地图
- 个性化走官方编辑器 https://lbs.baidu.com/customv2 （可视化调色，不手写 JSON），发布后得 styleId，代码 `map.setMapStyle({styleId})`（styleId 须与 AK 同账号）；也可导出 styleJson 内置，支持 `merge:true` 高性能合并与室内图样式
- 曾手写 styleJson 验证过机制可行（land/water 可覆盖，路网/公园要素名对不上默认色），但效果需在编辑器里精调；若未来旅行笔记要暗色主题，直接去编辑器生成 styleId 即可

## 5. 官方 Skill（对标 amap-jsapi-skill）

- 仓库 `baidu-maps/jsapi-skills`：`npx skills add baidu-maps/jsapi-skills`，含 `bmap-jsapi-gl`、`bmap-jsapi-three`、`jsapi-ui-kit` 三个 skill
- JSAPI 4.0 文档 13 类能力对标 amap-jsapi-skill：地图展示/状态/类型/交互事件/控件/右键菜单/样式/语言（高德缺）/GCJ02 兼容（迁移友好）/Marker/Label/InfoWindow/Polyline/贝塞尔（高德缺）/Polygon/Circle/Rectangle/点线面可视化图层/路况/室内图/全景/行政区图层/地址解析/定位/地点检索/路线规划——**全部 1:1 或超集覆盖**
- TS 类型：`@baidumap/jsapi-v4-types`；工程加载器：`@baidumap/jsapi-loader`（对标高德 `@amap/amap-jsapi-loader`）

## 6. 文件清单

```
KB/baidu-webservice/
├── INDEX.md                    # 本文件
├── scripts/test_baidu_basic.py # 16 项实测脚本（从 .env 读 AK，可复跑）
└── tests/raw/*.json|bin        # 真实响应留档

LAB/lab03-baidu-transit-demo/   # 浏览器端绘制验证（JSAPI 4.0）
├── index.html                  # 火车/飞机/驾车三路线绘制 demo
├── env.js                      # 浏览器端 AK（本地用，生产走代理）
└── route-data.js               # 服务端实测响应提取的 BD09LL 折线
```

复跑：`python3 KB/baidu-webservice/scripts/test_baidu_basic.py`
