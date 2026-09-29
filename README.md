# 学习养成助手 v4 — 前后端分离 + pi-sdk Agent 平台

## 快速开始

```bash
node server/index.ts          # 后端 :8791 (HTTP+WS, CORS开放)
# 浏览器打开 http://localhost:8791/
```

前端(`web/`)是纯静态,可独立部署: 改 `web/config.js` 的 backend 指向后端IP即可。

## 架构

```text
web/(纯静态) ──CORS──→ server :8791 (单进程)
  ├─ WS /voice-ws  ⇄ Gemini Live(云,仅声音/对话)
  │    · turn_complete零延迟放行(不等任何模型)
  │    · 转写镜像 → 模式词检测(聊天/监控) → 联网增强
  ├─ POST /vision  → 本地Qwen(state/read/monitor三模式,关思考后~1s)
  ├─ POST /decide  → 分类+搜索(调试/其他项目复用)
  ├─ POST /modes   → 模式切换(UI↔语音双向同步)
  └─ POST /snapshot → 调试拍照
server/core/agent.ts = pi-sdk会话工厂(平台核心,他项目可复用)
```

## 双模式

| | 聊天(默认) | 监控 |
|---|---|---|
| 视觉 | 仅按需精读("这题/卷子"触发,全幅≤2560px) | 自适应循环(~1s/帧+间隔),结构化{正在做/进度/专注/异常} |
| 主动播报 | 无 | 离席>2min提醒/低专注3帧提醒/任务完成祝贺(去抖+冷却) |
| 切换 | 语音"监控模式/聊天模式" 或 UI复选框(双向同步,语音确认) | |

## 联网搜索(异步补充模式)

问时效性问题 → Gemini先答(零等待) → 后台:正则快筛作业题(不搜)→本地Qwen分类→pi-sdk agent(web_search工具)搜索综合(实测26~44s)→等Gemini说完→注入补充→语音补播。

## 环境变量

`PORT`(8791) `LIVE_PROXY`(http://127.0.0.1:10808) `LIVE_MODEL`(gemini-3.8-live) `VISION_PROVIDER`(glm默认|local) `LOCAL_LLM`(http://192.168.5.101:28000/v1) `LOCAL_MODEL`(Qwen3.8-27B-NVFP4)

API key 全部运行时从 `~/.pi/agent/auth.json` 读取(google/zai-coding-cn), 不写进代码和仓库。

## 关键实测结论

- 本地Qwen3.8是思考型: 分类/视觉必须 `chat_template_kwargs:{enable_thinking:false}`,否则小预算下content为空(10.8s→0.9s的差距就在这)
- GLM coding端点(api.z.ai/api/coding/paas/v4)可直接用 glm-4.6v/4.5v 视觉(data URL base64, 实测2~3s/张), 用 Coding Plan key 无额外费用; 坏图/裁剪过头会回1210图片解析错误
- Gemini Live: 音频走client_content的inlineData(media_chunks被静默丢弃);说完必须发turn_complete;信令JSON可能以二进制帧到达
- web_search工具(pi-web-access)在SDK会话中可用,单次搜索26~44s → 只适合异步路径
- 浏览器采音: AEC开/NS关; 播报半双工+强插话检测在前端

## 目录

```text
server/(TypeScript,Node24直跑)  web/(纯静态前端)  shared/protocol.ts
tests/selftest.js  reference/  docs/
```

## 依赖服务

- 192.168.5.101:28000 本地vLLM(Qwen3.8-27B-NVFP4, 分类+搜索综合)
- GLM coding plan(z.ai, glm-4.6v 视觉默认)
- Gemini API + 出网代理

## 当前状态与下一步

> 更新: 2026-09-29

**✅ 已完成:**

- 前后端分离架构(server :8791 单进程 HTTP+WS, web/ 可独立部署)
- Gemini Live 全双工语音: turn_complete 零延迟放行、转写镜像、强插话检测
- 聊天/监控双模式, 语音+UI 双向同步切换
- 监控模式: 自适应视觉循环(~1s/帧) + 主动播报(离席>2min/低专注3帧/完成祝贺, 去抖+冷却)
- 异步联网搜索链路: Gemini先答 → 正则筛题 → 本地Qwen分类 → pi-sdk搜索(26~44s) → 语音补播
- 自检: `node tests/selftest.js`

**⏭️ 下一步:**

1. **视频帧通道**(已定, 下一阶段) — 监控视觉已切 GLM 云侧(2026-09-29); 进一步打通 Gemini Live 视频帧上行, 让对话侧也能实时看画面
2. 候选: 接入 :8101 CosyVoice2 TTS 替代 Gemini 语音(待其性能优化)
3. 候选: 接入 :8103 唤醒词「文森特卡索」, 摆脱手动点击启动

(语音服务见 `../voice-services/`)
