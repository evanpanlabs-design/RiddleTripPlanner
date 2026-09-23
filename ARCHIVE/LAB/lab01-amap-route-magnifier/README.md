# lab01 · amap-route-magnifier

> 第一个实验项目的存档：用高德 JSAPI v2.0 做一个「三层级通勤路线 + 圆形放大镜」交互 Demo。
> 存档时间：2026-09-21。

## 这个实验做了什么

在一张高德地图上同时画三条通勤路线（跨城 / 城区 / 园区），每条路线支持多种交通方式切换；点击任意一条线弹出**圆形放大镜**，放大镜内用独立子地图重新绘制该路线。放大镜可拖拽移动、拖边缘缩放、点外部关闭。主图支持鸟瞰 / 平面视角切换；底图与放大镜各可独立切换地图风格。

## 文件

- `index.html` —— 单文件 Demo（HTML/CSS/JS 全部内联），它是当时验证通过的最新版本。
- `env.js` —— 高德 JSAPI 凭证（Key + securityJsCode）。**仅本地调试用，切勿提交到公开仓库或放进生产前端**。

运行方式：把这两个文件放进同一目录，本地起一个静态服务器（如 `python3 -m http.server`），浏览器打开 `index.html` 即可。`env.js` 需自己填入「Web端(JS API)」的 Key 和安全密钥。

## 路线结构

| 层级 | 起点 → 终点 | 支持的交通方式 |
|------|-------------|----------------|
| 跨城 intercity | 天津站 → 北京南站 | 驾车、测地线 |
| 城区 city | 北京南站 → 北大东门 | 驾车、骑行、公交 |
| 园区 campus | 家园食堂 → 图书馆 | 步行、骑行 |

## 相关经验 / 踩坑

下面是这个实验里**非显然**的几点，写下来免得下次重踩。

### 1. JSAPI v2.0 `AMap.Riding` 的返回结构与官方 skill 示例不一致 ⚠️

官方 amap-jsapi-skill 的 `references/routing.md` 骑行示例写的是：

```js
result.routes[0].rides.forEach(ride => ride.path ...)
```

但 JSAPI v2.0 实测 `result.routes[0]` **没有 `.rides` 子结构**，单条骑行路线的坐标直接平铺在 `result.routes[0].path`（和 `AMap.Driving` / `AMap.Walking` 一致）。照抄示例会因 `route.rides` 为 undefined 取不到路径；如果再写成 `if(!res.rides)` 判空，会**误报「骑行规划失败」**（其实 `status === 'complete'`）。

**正确写法：**
```js
const r = (res.rides || res.routes)[0];
const path = r.path || [];
```

另外三层 API 的返回结构各不相同，记笔记务必注明来源层：

| 来源 | 结构 |
|------|------|
| JSAPI v2.0 | `result.routes[].path`（平铺） |
| Web Service V4 / MCP `maps_direction_bicycling` | `paths[].steps[]`，坐标在 step 级，可选 `polyline` |

### 2. 跨城交通：JSAPI 拿不到火车 / 飞机数据

- `AMap.Transfer`（公交换乘）**不支持跨城**，跨城调用直接失败。
- Web Service V5 的京津 transit 查询返回 `railway=[]`，也拿不到火车。
- 全链路没有任何接口能返回航班数据。

**Demo 的折中：** 跨城层用一条 `geodesic:true` 的大地线（大圆弧，地球曲面最短路径）作为「火车 / 飞机交通线」的代指，不再尝试拉真实班次。

### 3. 放大镜缩放要调 `map.resize()`，不是 `setSize()`

`AMap.Map` 没有 `setSize()`（那是 `InfoWindow` / `Marker` 的方法）。放大镜圆环拖拽改变尺寸后，子图容器变了，要调 `magMap.resize()` 让地图重新计算容器尺寸，否则子图渲染区域与圆框错位。

### 4. 放大镜用独立的 `AMap.Map` 实例

放大镜是一个 `overflow:hidden; border-radius:50%` 的圆 div，里面放一个全屏 `#mag-map`，`new AMap.Map('mag-map', {viewMode:'2D', ...})`。主图是 3D / 可调鸟瞰，**子图永远是 2D**（平面），避免圆框内出现透视畸变。关闭放大镜时调 `magMap.destroy()` 释放，下次打开重建。

### 5. 点击热区 + 主线分层

为了让细线也容易点中，每条路线实际由 3 条 Polyline 叠成：透明粗热区（`strokeWeight:22, strokeOpacity:0`，绑定点击）+ 光晕 + 主线。用 `typeof o.getPath === 'function'` 判定是否 Polyline 比靠 `getClassName()` 可靠。

### 6. 两套 Key 不能混

- **Web 服务 Key**：给 REST API / MCP 工具用。
- **Web端(JS API) Key + 安全密钥(securityJsCode)**：给 JSAPI 用，且 `window._AMapSecurityConfig` 必须在 `AMapLoader.load` 之前设好。

两者不是一个 Key。把 REST 的 Key 填进 JSAPI 会失败。

### 7. skill 铁律

写 JSAPI 代码前先按 skill 要求发一次遥测 curl；`.then((AMap)=>{})` 里**第一行**必须是 `AMap.getConfig().appname = 'amap-jsapi-skill';`，再 `new AMap.Map()`。

## 地图风格（11 种官方样式）

底图与放大镜可分别切换，全量如下（`map.setMapStyle('amap://styles/<值>')`）：

标准 normal · 幻影黑 dark · 月光银 light · 远山黛 whitesmoke · 草色青 fresh · 雅士灰 grey · 涂鸦 graffiti · 马卡龙 macaron · 靛青蓝 blue · 极夜蓝 darkblue · 酱籽 wine

## 从这个实验得到的记忆

已写入项目记忆库（`memory/`）：`jsapi-riding-result-structure.md` —— Riding 返回 `res.routes[].path` 而非 skill 示例的 `res.rides`。
