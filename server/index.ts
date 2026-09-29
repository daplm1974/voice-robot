/** index.ts — 学习养成助手后端入口
 * 前后端分离: 本进程提供 HTTP(CORS) + WS /voice-ws, 静态托管web/仅为便利。
 * 启动: node server/index.ts
 */
import http from 'node:http';
import { config } from './core/config.ts';
import { createClassifier } from './core/classifier.ts';
import { createSearchService, initSearchSelfCheck } from './services/search.ts';
import { createSupervisor } from './services/supervisor.ts';
import { attachApi } from './api.ts';
import { attachVoiceChannel } from './channels/gemini-live.ts';

const classifier = createClassifier(config.localLlm, config.localModel);
const search = createSearchService(classifier);
const supervisor = createSupervisor();

const server = http.createServer();
const channel = attachVoiceChannel(server, { search, supervisor });
attachApi(server, { search, supervisor, injectSystem: channel.injectSystem });

initSearchSelfCheck(search).then(() => {
  server.listen(config.port, () => {
    console.log('🤖 学习养成助手后端(pi-sdk平台)');
    console.log(`   http://localhost:${config.port}/  | WS /voice-ws | CORS回显Origin`);
    console.log(`   本地推理: ${config.localModel} @ ${config.localLlm}`);
    console.log(`   视觉: ${config.visionProvider} | Gemini: ${config.geminiModel} | 代理: ${config.proxy}`);
  });
});
