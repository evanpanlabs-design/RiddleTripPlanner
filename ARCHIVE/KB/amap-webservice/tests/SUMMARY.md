# Amap Web Service 测试结果汇总

Key 来源:`~/.claude.json` 的 MCP 配置(Web服务 Key)。测试时间见文件 mtime。

| 测试名 | 端点 | status | infocode | info |
|---|---|---|---|---|
| geocode | `/v3/geocode/geo` | 1 | 10000 | OK |
| regeocode | `/v3/geocode/regeo` | 1 | 10000 | OK |
| direction-walking | `/v3/direction/walking` | 1 | 10000 | ok |
| direction-driving-v3 | `/v3/direction/driving` | 1 | 10000 | OK |
| direction-transit | `/v3/direction/transit/integrated` | 1 | 10000 | OK |
| direction-bicycling-v4 | `/v4/direction/bicycling` | 0 | - | OK |
| driving-v5-newroute | `/v5/direction/driving` | 1 | 10000 | OK |
| district | `/v3/config/district` | 1 | 10000 | OK |
| ip-v3 | `/v3/ip` | 1 | 10000 | OK |
| convert | `/v3/assistant/coordinate/convert` | 1 | 10000 | ok |
| staticmap | `/v3/staticmap (PNG)` | 1 | - | (PNG image) |
| v5-place-text | `/v5/place/text` | 1 | 10000 | OK |
| v5-place-around | `/v5/place/around` | 1 | 10000 | OK |
| v5-place-polygon | `/v5/place/polygon` | 1 | 10000 | OK |
| v5-place-detail | `/v5/place/detail` | 1 | 10000 | OK |
| v3-place-text | `/v3/place/text` | 1 | 10000 | OK |
| v3-place-around | `/v3/place/around` | 1 | 10000 | OK |
| v5-aoi-polyline | `/v5/aoi/polyline` | 0 | 10012 | INSUFFICIENT_PRIVILEGES |
| v3-inputtips | `/v3/assistant/inputtips` | 1 | 10000 | OK |
| v3-weather-all | `/v3/weather/weatherInfo?ext=all` | 1 | 10000 | OK |
| v3-weather-base | `/v3/weather/weatherInfo?ext=base` | 1 | 10000 | OK |
| v5-ip-location | `/v5/ip/location` | 0 | 10012 | INSUFFICIENT_PRIVILEGES |
| v3-traffic-circle | `/v3/traffic/status/circle` | 1 | 10000 | OK |
| v3-traffic-rectangle | `/v3/traffic/status/rectangle` | 1 | 10000 | OK |
| v3-traffic-road | `/v3/traffic/status/road` | 1 | 10000 | OK |
| v3-bus-linename | `/v3/bus/linename` | 1 | 10000 | OK |
| v3-bus-stopname | `/v3/bus/stopname` | 1 | 10000 | OK |
| v5-walking | `/v5/direction/walking` | 1 | 10000 | OK |
| v5-electrobike | `/v5/direction/electrobike` | 1 | 10000 | OK |
| v5-driving-cost | `/v5/direction/driving?show_fields=cost` | 1 | 10000 | OK |
| v5-transit-intercity | `/v5/direction/transit/integrated` | 1 | 10000 | OK |
| v5-bicycling | `/v5/direction/bicycling` | 1 | 10000 | OK |
| v4-etd-driving | `/v4/etd/driving` | 10012 | - | INSUFFICIENT_PRIVILEGES |
| geohub-place-text | `/rest/lbs/geohub/place/text` | 0 | 20000 | INVALID_PARAMS |
| v4-grasproad | `/v4/grasproad/driving POST` | 30001 | - | ENGINE_RESPONSE_DATA_ERROR |
| v5-position-iot | `/v5/position/IoT POST` | 0 | 10012 | INSUFFICIENT_PRIVILEGES |
| v3-transit-intercity | `/v3/direction/transit/integrated` | 1 | 10000 | OK |