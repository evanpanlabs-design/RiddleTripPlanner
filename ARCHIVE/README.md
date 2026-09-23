# ARCHIVE · 探索与资料档案

> 这里存档 Riddle 从灵感到实现的完整探索链路与开发参考资料，供云端开发环境（CatDesk）及任何新环境快速重建上下文。
> 主线代码在 `APP/` + `UI/`，现行技术规格在 `SPEC/`，本目录是它们的"前世今生"。

## 探索链路（按时间顺序读）

```
RAWIDEAS          旅行计划元素脑图（.km）——一切的起点
   ↓
ANALYSIS          五份分析共识：信息架构 / 意图与槽位 / MVP 范围 / 竞对矩阵 / 圆周旅迹拆解
   ↓
PRD               产品需求文档 v0.2（已审议，稳定，回答 what/why）
   ↓
SPEC/（仓库根）    技术规格 + ARCH-pi（常变，回答 how）
   ↓
LAB               四个验证原型中的三个（lab04 为空目录未归档）：
                  · lab01 高德路线放大镜——JSAPI 渲染与路线数据可行性
                  · lab02 Python Agent 管线——APP/ 的直系祖先：Jev 判别问题集（questions.py）、
                    orchestrator 主循环、store 事件溯源，现行 TS 版逐文件移植自这里
                  · lab03 百度跨城大交通 demo——baidu_transit 真实班次数据源验证
   ↓
APP/ + UI/        现行实现（pi-agent-core 编排 + Jev 判别 + LLM 生成）
```

## KB · API 资料库

- `KB/amap-webservice`：高德 Web 服务 API 的策展文档（INDEX/ENDPOINTS）+ 原始官方文档 HTML + 探测脚本与测试。
- `KB/baidu-webservice`：百度 Web 服务 API（place detail、跨城 transit）同上。
- `KB/jev`：TypeSafe Jev（System One）接入要点。

## teardown · 竞对原始素材

`teardown/圆周旅迹详情页.html` 是 ANALYSIS/05 拆解的原始页面存档（仅主文档，静态资源目录未归档）。

## 密钥说明

各 lab 的 `env.js`（高德/百度前端凭证）**未归档**（`.gitignore` 规则 `**/env.js`，仓库公开）。在新环境重建时：
lab01/lab03 的 `env.js` 按各自 index.html 顶部注释说明，填入自己的高德 JSAPI key + securityJsCode（或百度 AK）即可；
`APP/` 运行所需凭证通过应用内设置面板或环境变量配置（见根 README 与 `.env.example` 范式）。
