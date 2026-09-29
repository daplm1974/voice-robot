/** search.ts — 联网搜索(pi-sdk agent + web_search工具, 本地Qwen综合) */
import { createAgent, checkWebSearchTool } from '../core/agent.ts';
import type { DecideResponse } from '../../shared/protocol.ts';

const SEARCH_SYSTEM = `你是搜索助理。收到问题后调用web_search工具搜索,
然后输出不超过3条要点,每条不超过40字,格式: "- 要点(来源域名)"。
不要客套,不要长篇解释。如果搜索失败,输出"搜索失败"。`;

export interface SearchService {
  decide(question: string): Promise<DecideResponse>;
  webSearchAvailable: boolean;
}

export function createSearchService(classifier: { classify: (q: string) => Promise<{ intent: string; by: string; ms: number }> }): SearchService {
  const service: SearchService = {
    webSearchAvailable: false,
    async decide(question) {
      const t0 = Date.now();
      const cls = await classifier.classify(question);
      if (cls.intent !== 'fact') {
        return { action: 'pass', reason: cls.intent as 'homework' | 'chat', ms: Date.now() - t0 };
      }
      // fact → 联网搜索
      if (!service.webSearchAvailable) {
        return { action: 'pass', reason: 'timeout', ms: Date.now() - t0 }; // 工具缺失fail-open
      }
      let agent: Awaited<ReturnType<typeof createAgent>> | null = null;
      try {
        const timer = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('搜索超时')), 15000));
        agent = await Promise.race([createAgent({ systemPrompt: SEARCH_SYSTEM }), timer]);
        const summary = await agent.prompt('请搜索并回答: ' + question, 55000); // web_search实测~44s, 异步路径可等
        if (!summary || summary.includes('搜索失败') || summary.length < 10) {
          return { action: 'pass', reason: 'timeout', ms: Date.now() - t0 };
        }
        return { action: 'inject', reason: 'fact', context: summary, ms: Date.now() - t0 };
      } catch {
        return { action: 'pass', reason: 'timeout', ms: Date.now() - t0 }; // fail-open
      } finally {
        if (agent) agent.dispose();
      }
    },
  };
  return service;
}

/** 启动时自检(异步, 不阻塞服务) */
export async function initSearchSelfCheck(svc: SearchService): Promise<void> {
  svc.webSearchAvailable = await checkWebSearchTool();
  console.log(`[search] web_search工具: ${svc.webSearchAvailable ? '✅可用' : '❌缺失(fail-open)'}`);
}
