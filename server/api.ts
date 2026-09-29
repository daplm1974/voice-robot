/** api.ts — 统一REST路由(CORS开放, 前后端分离契约) */
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.ts';
import { runVision, parseMonitorState } from './services/vision.ts';
import type { SearchService } from './services/search.ts';
import type { Supervisor } from './services/supervisor.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

export interface ApiDeps {
  search: SearchService;
  supervisor: Supervisor;
  injectSystem: (text: string) => void;
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  // 本服务无cookie/凭证, 采用回显Origin(仅允许请求方自身源, 不用通配符)
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, err) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => ok(b));
    req.on('error', err);
  });
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function attachApi(server: Server, deps: ApiDeps): void {
  server.on('request', async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204); res.end(); return; }

    // 静态托管web/(开发便利, 前端也可独立部署)
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(WEB_DIR, 'index.html')).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.startsWith('/web/')) {
      const file = path.join(WEB_DIR, path.normalize(url.slice(4)).replace(/^([.][.])+/, ''));
      if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8' };
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }

    cors(req, res);

    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, {
        status: 'ok',
        mode: deps.supervisor.getMode(),
        webSearch: deps.search.webSearchAvailable,
        vision: config.visionProvider,
      });
    }

    if (req.method === 'GET' && url === '/modes') {
      return json(res, 200, { mode: deps.supervisor.getMode() });
    }

    if (req.method === 'POST' && url === '/modes') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { mode?: 'chat' | 'monitor' };
        if (body.mode !== 'chat' && body.mode !== 'monitor') throw new Error('mode须为chat|monitor');
        const prev = deps.supervisor.getMode();
        deps.supervisor.setMode(body.mode);
        if (prev !== body.mode) {
          deps.injectSystem(body.mode === 'monitor' ? '已切换到监控模式,请简短确认并开始关注孩子学习' : '已切换到聊天模式,请简短确认');
        }
        return json(res, 200, { mode: body.mode });
      } catch (e) {
        return json(res, 400, { detail: String((e as Error).message || e) });
      }
    }

    if (req.method === 'POST' && url === '/vision') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { image?: string; mode?: 'state' | 'read' | 'monitor' };
        if (!body.image) throw new Error('no image');
        const result = await runVision(body.image, body.mode || 'state');
        let cmd: unknown = { kind: 'none' };
        if ((body.mode || 'state') === 'monitor') {
          const st = parseMonitorState(result.description);
          if (st) {
            cmd = deps.supervisor.observe({ ...st, intervalMs: Number(req.headers['x-interval-ms'] || 5000) });
            if ((cmd as { kind: string }).kind !== 'none') {
              deps.injectSystem((cmd as { text: string }).text); // 主动播报
            }
          }
          return json(res, 200, { ...result, state: st, cmd });
        }
        return json(res, 200, result);
      } catch (e) {
        return json(res, 502, { detail: String((e as Error).message || e) });
      }
    }

    if (req.method === 'POST' && url === '/decide') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { question?: string };
        if (!body.question) throw new Error('no question');
        const r = await deps.search.decide(body.question);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { detail: String((e as Error).message || e) });
      }
    }

    if (req.method === 'POST' && url === '/snapshot') {
      try {
        const body = JSON.parse(await readBody(req) || '{}') as { image?: string };
        if (!body.image) throw new Error('no image');
        const buf = Buffer.from(body.image, 'base64');
        fs.writeFileSync(path.join(__dirname, '..', 'snapshot.jpg'), buf);
        return json(res, 200, { saved: 'snapshot.jpg', bytes: buf.length });
      } catch (e) {
        return json(res, 502, { detail: String((e as Error).message || e) });
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not Found' }));
  });
}
