/** classifier.ts — 意图分类(本地Qwen, 思考无关/单发/快) */

export type Intent = 'homework' | 'fact' | 'chat';

const HOMEWORK_RE = /等于|加法|减法|乘法|除法|口算|竖式|第\s*[一二三四五六七八九十\d]+\s*题|这道题|算式|计算|解方程|应用题|×|÷|\*\s*\d|\d\s*[+\-x×÷]\s*\d/;

const PROMPT = `你是问题分类器。把用户输入分为三类,只输出一个小写单词:
- homework: 作业/习题/口算/需要计算的题目
- fact: 需要联网查证的时效性或事实性问题(新闻/天气/比分/最新/谁赢/什么时候/多少岁等)
- chat: 闲聊/命令/其他(不需要搜索)
只输出一个词,不要其他内容。

用户输入: `;

export interface ClassifyResult {
  intent: Intent;
  by: 'regex' | 'llm' | 'fallback';
  ms: number;
}

export function createClassifier(localLlm: string, localModel: string) {
  async function classify(question: string): Promise<ClassifyResult> {
    const t0 = Date.now();
    // 第一道闸: 正则快筛作业题(零成本零延迟)
    if (HOMEWORK_RE.test(question)) {
      return { intent: 'homework', by: 'regex', ms: Date.now() - t0 };
    }
    // 第二道闸: 本地LLM分类
    try {
      const r = await fetch(localLlm + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: localModel,
          max_tokens: 32,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false }, // Qwen3.8思考型: 不关思考小预算全被思考吃掉
          messages: [{ role: 'user', content: PROMPT + question.slice(0, 300) }],
        }),
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json();
      const txt: string = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim().toLowerCase();
      if (txt.includes('homework')) return { intent: 'homework', by: 'llm', ms: Date.now() - t0 };
      if (txt.includes('fact')) return { intent: 'fact', by: 'llm', ms: Date.now() - t0 };
      return { intent: 'chat', by: 'llm', ms: Date.now() - t0 };
    } catch {
      return { intent: 'chat', by: 'fallback', ms: Date.now() - t0 }; // fail-open
    }
  }
  return { classify };
}
