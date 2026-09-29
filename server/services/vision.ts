/** vision.ts — 视觉服务(GLM默认/本地Qwen备选; state/read/monitor三模式) */
import { config, readZaiKey } from '../core/config.ts';

const VISION_PROMPT = '你是家庭机器人的眼睛。用一两句话描述画面重点:有什么人/物品/文字(画面里有算式、题目或作业必须原样读出内容)。直接描述,不要客套。';
const VISION_READ_PROMPT = '你是高精度OCR。逐行抄录画面纸面/书本/屏幕上的所有可见文字,算式和数字必须原样保留,handwriting也照抄;不要解释、不要总结、不要漏行。最后另起一行用「状态:」开头一句话描述人在做什么。';
const VISION_MONITOR_PROMPT = `你是学习监督摄像头分析器。观察画面输出严格JSON(不要多余文字):
{"doing":"正在做什么(≤15字)","progress":"学习任务进度估计(≤15字,如:第3题/约完成一半/未在学习)","focus":"high|mid|low(专注度)","anomaly":"none|away(离席)|distracted(玩别的)|other"}`;

interface ProviderCfg { url: string; model: string; auth?: string; extra?: Record<string, unknown> }

/** 出网白名单: 视觉只允许这些主机(防SSRF) */
const ALLOWED_HOSTS = ['open.bigmodel.cn', 'api.z.ai', '192.168.5.101', '127.0.0.1', 'localhost'];

function assertAllowedUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`无效URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.includes(u.hostname)) {
    throw new Error(`目标主机不在白名单: ${u.hostname}`);
  }
}

function providerCfg(): ProviderCfg {
  if (config.visionProvider === 'glm') {
    return { url: 'https://api.z.ai/api/coding/paas/v4/chat/completions', model: 'glm-4.6v', auth: 'Bearer ' + readZaiKey(), extra: {} };
  }
  // 本地Qwen3.8是思考型: 必须关思考,否则小预算下content为空
  let u: URL;
  try {
    u = new URL(config.localLlm);
  } catch {
    throw new Error(`LOCAL_LLM配置无效: ${config.localLlm}`);
  }
  u.pathname = '/v1/chat/completions';
  return { url: u.toString(), model: config.localModel, auth: undefined, extra: { chat_template_kwargs: { enable_thinking: false } } };
}

export interface VisionResult {
  description: string;
  error?: string | null;
  ms: number;
}

export async function runVision(imageB64: string, mode: 'state' | 'read' | 'monitor'): Promise<VisionResult> {
  const t0 = Date.now();
  const cfg = providerCfg();
  const prompt = mode === 'read' ? VISION_READ_PROMPT : mode === 'monitor' ? VISION_MONITOR_PROMPT : VISION_PROMPT;
  const maxTokens = mode === 'state' ? 200 : 500;
  try {
    assertAllowedUrl(cfg.url);
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.auth ? { Authorization: cfg.auth } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        ...cfg.extra,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } },
          { type: 'text', text: prompt },
        ] }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    const c = j.choices && j.choices[0] && j.choices[0].message;
    console.log(`[vision:${config.visionProvider}/${mode}] ${((Date.now() - t0) / 1000).toFixed(1)}s: ${c && c.content ? String(c.content).trim().slice(0, 70) : '(空)'}`);
    return { description: c && c.content ? String(c.content).trim() : '', error: c ? null : JSON.stringify(j).slice(0, 120), ms: Date.now() - t0 };
  } catch (e) {
    return { description: '', error: (e as Error).message, ms: Date.now() - t0 };
  }
}

/** 从monitor模式的输出中解析结构化状态(容错) */
export function parseMonitorState(raw: string): { doing: string; progress: string; focus: string; anomaly: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      doing: String(j.doing || '').slice(0, 30),
      progress: String(j.progress || '').slice(0, 30),
      focus: ['high', 'mid', 'low'].includes(j.focus) ? j.focus : 'unknown',
      anomaly: ['none', 'away', 'distracted', 'other'].includes(j.anomaly) ? j.anomaly : 'unknown',
    };
  } catch {
    return null;
  }
}
