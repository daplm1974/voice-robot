/** agent.ts — pi-sdk 会话工厂(平台核心, 可复用)
 * 提供带工具(如web_search)的本地模型agent会话;
 * 其他项目可 import 本模块复用。
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface AgentFactoryOptions {
  systemPrompt: string;
  localModel?: string;          // models.json 里的 provider/model id
  localProvider?: string;
}

export interface AgentHandle {
  prompt: (text: string, timeoutMs?: number) => Promise<string>;
  dispose: () => void;
  toolNames: string[];
}

let cachedRuntime: Awaited<ReturnType<typeof ModelRuntime.create>> | null = null;

async function getRuntime() {
  if (!cachedRuntime) cachedRuntime = await ModelRuntime.create();
  return cachedRuntime;
}

/** 创建一次性agent会话(每次搜索新建, 避免上下文污染) */
export async function createAgent(opts: AgentFactoryOptions): Promise<AgentHandle> {
  const runtime = await getRuntime();
  const model = runtime.getModel(opts.localProvider || 'local-vllm', opts.localModel || 'Qwen3.8-27B-NVFP4');
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => opts.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    resourceLoader: loader,
    model: model ?? undefined,
    thinkingLevel: 'off',
    sessionManager: SessionManager.inMemory(),
  });
  let lastText = '';
  const unsubscribe = session.subscribe(ev => {
    if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'text_delta') {
      lastText += ev.assistantMessageEvent.delta;
    }
  });
  const toolNames = session.getActiveToolNames();
  return {
    toolNames,
    async prompt(text: string, timeoutMs = 20000): Promise<string> {
      lastText = '';
      const timer = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('agent超时')), timeoutMs));
      await Promise.race([session.prompt(text), timer]);
      return lastText.trim();
    },
    dispose() {
      unsubscribe();
      session.dispose();
    },
  };
}

/** 启动自检: web_search工具是否可用 */
export async function checkWebSearchTool(): Promise<boolean> {
  try {
    const a = await createAgent({ systemPrompt: '自检' });
    const ok = a.toolNames.some(n => /web.?search|search/i.test(n));
    a.dispose();
    return ok;
  } catch {
    return false;
  }
}
