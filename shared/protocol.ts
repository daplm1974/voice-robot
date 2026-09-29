/** protocol.ts — 前后端协议定义（单一事实来源）
 *
 * 后端直接 import 本文件；前端(web/)不跑TS，
 * 对应的消息结构以本文件注释为文档，改动需手动同步前端。
 */

/** 服务端 → 浏览器 的控制消息（JSON文本帧或HTTP响应） */
export interface ServerToClient {
  type:
    | 'ready'      // Gemini setup完成,可开始说话
    | 'error'      // 错误 {message}
    | 'mode'       // 模式切换 {mode: 'chat'|'monitor'}
    | 'status';    // 状态提示 {text: '正在联网查证…'|'已注入联网资料'|...}
  message?: string;
  mode?: 'chat' | 'monitor';
  text?: string;
}

/** 浏览器 → 服务端 视觉请求 POST /vision */
export interface VisionRequest {
  image: string;              // base64 JPEG(不带data:前缀)
  mode: 'state' | 'read' | 'monitor';
}

/** POST /vision 响应 */
export interface VisionResponse {
  description: string;        // state/read: 文字描述; monitor: JSON字符串
  error?: string | null;
}

/** 调试/复用接口 POST /decide */
export interface DecideRequest {
  question: string;
}

export interface DecideResponse {
  action: 'pass' | 'inject';
  reason: 'homework' | 'chat' | 'fact' | 'timeout' | 'error';
  context?: string;           // inject时的注入文本(不含包装)
  ms: number;                 // 决策耗时
}

/** 监控模式结构化状态(vision monitor模式输出, 解析失败时为null字段) */
export interface MonitorState {
  doing: string;
  progress: string;
  focus: 'high' | 'mid' | 'low' | 'unknown';
  anomaly: 'none' | 'away' | 'distracted' | 'other' | 'unknown';
}

/** 环境配置(server/index.ts读取) */
export interface ServerConfig {
  port: number;               // 默认 8791
  proxy: string;              // Gemini出网代理, 默认 http://127.0.0.1:10808
  geminiModel: string;        // 默认 gemini-3.8-live
  visionProvider: 'local' | 'glm';
  localLlm: string;           // 本地vLLM基址, 默认 http://192.168.5.101:28000/v1
  localModel: string;         // 本地模型id, 默认 Qwen3.8-27B-NVFP4
}
