/** config.ts — 环境配置(单一来源) */
import path from 'node:path';
import fs from 'node:fs';

export interface Config {
  port: number;
  proxy: string;
  geminiModel: string;
  visionProvider: 'local' | 'glm';
  localLlm: string;
  localModel: string;
}

export const config: Config = {
  port: Number(process.env.PORT || 8791),
  proxy: process.env.LIVE_PROXY || 'http://127.0.0.1:10808',
  geminiModel: process.env.LIVE_MODEL || 'gemini-3.8-live',
  visionProvider: (process.env.VISION_PROVIDER as 'local' | 'glm') || 'local',
  localLlm: process.env.LOCAL_LLM || 'http://192.168.5.101:28000/v1',
  localModel: process.env.LOCAL_MODEL || 'Qwen3.8-27B-NVFP4',
};

export function readGoogleKey(): string {
  const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.pi/agent/auth.json');
  let j: { google?: { key?: string }; 'zai-coding-cn'?: { key?: string } };
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error('读取auth.json失败: ' + (e as Error).message);
  }
  const k = j.google && j.google.key;
  if (!k) throw new Error('auth.json 无 google.key');
  return k;
}

export function readZaiKey(): string {
  const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.pi/agent/auth.json');
  let j: { google?: { key?: string }; 'zai-coding-cn'?: { key?: string } };
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error('读取auth.json失败: ' + (e as Error).message);
  }
  const k = j['zai-coding-cn'] && j['zai-coding-cn'].key;
  if (!k) throw new Error('auth.json 无 zai-coding-cn.key');
  return k;
}
