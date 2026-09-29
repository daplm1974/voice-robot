/** gemini-live.ts — 语音通道适配器
 * 职责: WS透传Gemini Live + turn_complete拦截(搜索) + 转写镜像(模式词) + 主动播报注入
 */
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Server } from 'node:http';
import { config, readGoogleKey } from '../core/config.ts';
import type { SearchService } from '../services/search.ts';
import type { Supervisor } from '../services/supervisor.ts';

const UPSTREAM = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${readGoogleKey()}`;
const agent = /^socks/i.test(config.proxy) ? new SocksProxyAgent(config.proxy) : new HttpsProxyAgent(config.proxy);

const MODE_MONITOR_RE = /监控模式|开启监控|开始监控|盯(着|着点)/;
const MODE_CHAT_RE = /聊天模式|停止监控|关闭监控/;
const PCM_TURN = 16000; // 0.5s @16k s16le

export interface LiveSessionHooks {
  search: SearchService;
  supervisor: Supervisor;
  /** 主动播报(供supervisor/模式确认) */
  injectSystem?: (text: string) => void;
}

interface ActiveSession {
  ws: import('ws').WebSocket;
  upstream: import('ws').WebSocket;
}

export function attachVoiceChannel(server: Server, hooks: LiveSessionHooks): { injectSystem: (text: string) => void } {
  const wss = new WebSocketServer({ noServer: true });
  let active: ActiveSession | null = null;
  let sessionCount = 0;

  hooks.injectSystem = (text: string) => {
    if (active && active.upstream.readyState === WebSocket.OPEN) {
      active.upstream.send(JSON.stringify({
        client_content: { turns: [{ role: 'user', parts: [{ text: `(系统:${text})` }] }], turn_complete: true },
      }));
    } else {
      console.log('[inject无会话丢弃]', text.slice(0, 50));
    }
  };

  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/voice-ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      const id = ++sessionCount;
      console.log(`[语音${id}] 浏览器接入, 经代理 ${config.proxy} 连接 ${config.geminiModel}`);
      let upstream: import('ws').WebSocket;
      try {
        upstream = new WebSocket(UPSTREAM, { agent });
      } catch {
        ws.close(1011, 'proxy fail');
        return;
      }
      active = { ws, upstream };

      let setupOk = false;
      const pending: (string | Buffer)[] = [];
      const t0 = Date.now();
      let pcmBuf = Buffer.alloc(0);
      let accText = '';          // 转写镜像(本轮累计)
      let botSpeaking = false;
      let turnSeq = 0;           // turn代际(新turn取消旧决策)

      const mkAudioTurn = (b64: string) => JSON.stringify({
        client_content: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: b64 } }] }] },
      });
      const sendUp = (msg: string | Buffer) => {
        if (upstream.readyState !== WebSocket.OPEN) { pending.push(msg); return; }
        upstream.send(msg as never);
      };

      upstream.on('open', () => {
        console.log(`[语音${id}] 上游已连接 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        while (pending.length) { try { upstream.send(pending.shift() as never); } catch { /* 刚断开 */ } }
      });
      upstream.on('message', (data: Buffer, isBin: boolean) => {
        if (isBin) {
          const s = data.toString('utf8');
          if (s.trimStart().startsWith('{')) { handleUpJson(s); return; }
          ws.send(data); // 真音频直通
          return;
        }
        handleUpJson(data.toString());
      });
      function handleUpJson(s: string) {
        let j: Record<string, never> | { setupComplete?: unknown; error?: { message?: string }; transcription?: { inputTranscription?: { text?: string } }; serverContent?: Record<string, unknown> };
        try { j = JSON.parse(s); } catch { ws.send(s); return; }
        const jj = j as { setupComplete?: unknown; error?: { message?: string }; transcription?: { inputTranscription?: { text?: string } }; serverContent?: Record<string, unknown> };
        if (jj.setupComplete) {
          console.log(`[语音${id}] setup完成 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
          ws.send(JSON.stringify({ type: 'ready' }));
        } else if (jj.error) {
          ws.send(JSON.stringify({ type: 'error', message: (jj.error.message || '').slice(0, 200) }));
        }
        // 转写镜像: 累计 + 模式词检测
        const tin = jj.transcription && jj.transcription.inputTranscription && jj.transcription.inputTranscription.text;
        if (tin) {
          accText += tin;
          tryDetectMode(String(tin));
        }
        // 播报状态(供主动播报避让)
        const sc = jj.serverContent;
        if (sc) {
          const mt = sc.modelTurn as { parts?: Array<{ inlineData?: unknown }> } | undefined;
          if (mt && mt.parts && mt.parts.some(p => p.inlineData)) botSpeaking = true;
          if (sc.turnComplete || sc.interrupted) botSpeaking = false;
        }
        ws.send(s); // 原样透传
      }
      function tryDetectMode(t: string) {
        if (MODE_MONITOR_RE.test(t) && hooks.supervisor.getMode() !== 'monitor') {
          hooks.supervisor.setMode('monitor');
          ws.send(JSON.stringify({ type: 'mode', mode: 'monitor' }));
          console.log(`[语音${id}] → 监控模式`);
          if (!botSpeaking) hooks.injectSystem('已切换到监控模式,请简短确认并开始关注孩子学习');
        } else if (MODE_CHAT_RE.test(t) && hooks.supervisor.getMode() !== 'chat') {
          hooks.supervisor.setMode('chat');
          ws.send(JSON.stringify({ type: 'mode', mode: 'chat' }));
          console.log(`[语音${id}] → 聊天模式`);
          if (!botSpeaking) hooks.injectSystem('已切换到聊天模式,请简短确认');
        }
      }

      upstream.on('error', e => {
        console.error(`[语音${id}] 上游错误:`, e.message);
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
        ws.close();
      });
      upstream.on('close', (code: number) => {
        console.log(`[语音${id}] 上游关闭 code=${code}`);
        try { ws.close(); } catch { /* already closed */ }
      });

      ws.on('message', (data: Buffer, isBin: boolean) => {
        // 二进制PCM: 持续攒包转发(拦截期间也不断)
        if (isBin) {
          pcmBuf = Buffer.concat([pcmBuf, data]);
          while (pcmBuf.length >= PCM_TURN) {
            const piece = pcmBuf.subarray(0, PCM_TURN);
            pcmBuf = pcmBuf.subarray(PCM_TURN);
            sendUp(mkAudioTurn(piece.toString('base64')));
          }
          return;
        }
        let j: { client_content?: { turn_complete?: boolean; turns?: unknown }; setup?: { systemText?: string; voice?: string } };
        try { j = JSON.parse(data.toString()); } catch { return; }
        if (j.client_content && j.client_content.turn_complete) {
          const myTurn = ++turnSeq;
          releaseTurn(myTurn, j.client_content.turns).catch(e =>
            console.error(`[语音${id}] 拦截异常(fail-open):`, (e as Error).message));
          return;
        }
        if (j.setup && !setupOk) {
          setupOk = true;
          const msg = JSON.stringify({
            setup: {
              model: `models/${config.geminiModel}`,
              generation_config: {
                response_modalities: ['AUDIO'],
                speech_config: { voice_config: { prebuilt_voice_config: { voice_name: j.setup.voice || 'Aoede' } } },
              },
              system_instruction: { parts: [{ text: (j.setup.systemText || '你是家庭学习助手,回答简短口语化。').slice(0, 2000) }] },
              input_audio_transcription: {},
              output_audio_transcription: {},
              realtime_input_config: {
                automatic_activity_detection: {
                  disabled: false,
                  start_of_speech_sensitivity: 'START_SENSITIVITY_HIGH',
                  end_of_speech_sensitivity: 'END_SENSITIVITY_HIGH',
                  prefix_padding_ms: 300,
                  silence_duration_ms: 700,
                },
              },
            },
          });
          console.log(`[语音${id}] →setup(${msg.length}B)`);
          sendUp(msg);
          return;
        }
        sendUp(data.toString());
      });

      /** 从浏览器turns里提取文字(文字提问也走联网增强) */
      function extractText(turns: unknown): string {
        if (!Array.isArray(turns)) return '';
        let s = '';
        for (const t of turns as Array<{ parts?: Array<{ text?: string }> }>) {
          for (const p of (t.parts || [])) {
            if (p.text && !/^[(（](卷面内容|当前画面|系统)/.test(p.text)) s += p.text;
          }
        }
        return s;
      }

      /** 拦截核心: 零延迟放行; 分类与搜索全异步, 查到后择机注入补充 */
      async function releaseTurn(myTurn: number, browserTurns: unknown): Promise<void> {
        await new Promise(r => setTimeout(r, 400)); // 等转写尾包
        if (myTurn !== turnSeq) return;
        const question = (accText || extractText(browserTurns)).slice(-200);
        accText = '';
        // 放行(不等任何模型)
        if (pcmBuf.length > 1600) { sendUp(mkAudioTurn(pcmBuf.toString('base64'))); }
        pcmBuf = Buffer.alloc(0);
        const turns = Array.isArray(browserTurns) ? browserTurns : [];
        sendUp(JSON.stringify({ client_content: { ...(turns.length ? { turns } : {}), turn_complete: true } }));
        console.log(`[语音${id}] →turn_complete释放`);
        // 异步智能链: 分类→搜索→择机注入(不影响响应速度)
        if (question.trim().length >= 2) {
          void asyncAugment(myTurn, question);
        }
      }

      async function asyncAugment(myTurn: number, question: string): Promise<void> {
        try {
          const decided = await hooks.search.decide(question);
          if (myTurn !== turnSeq) return;             // 已进入新一轮对话,丢弃旧资料
          console.log(`[语音${id}] 异步决策: ${decided.action}/${decided.reason} (${decided.ms}ms)`);
          if (decided.action !== 'inject' || !decided.context) return;
          ws.send(JSON.stringify({ type: 'status', text: '已联网查证,准备补充…' }));
          // 等Gemini说完当前轮再注入(最多等95s)
          for (let i = 0; i < 190 && botSpeaking && myTurn === turnSeq; i++) {
            await new Promise(r => setTimeout(r, 500));
          }
          if (myTurn !== turnSeq || !active || active.ws !== ws) return;
          hooks.injectSystem(`联网资料已查到:${decided.context}。请用一两句话向孩子补充刚才的回答,若与已答内容重复就不必再说。`);
          console.log(`[语音${id}] 注入联网补充(${decided.ms}ms)`);
        } catch (e) {
          console.error(`[语音${id}] 异步补充失败(忽略):`, (e as Error).message);
        }
      }

      ws.on('close', () => {
        console.log(`[语音${id}] 浏览器断开`);
        turnSeq++; // 取消未完成决策
        if (active && active.ws === ws) active = null;
        try { upstream.close(); } catch { /* noop */ }
      });
    });
  });

  return { injectSystem: hooks.injectSystem };
}
