const WebSocket = require('ws');
const fs = require('fs');
const out = [];
const ws = new WebSocket('ws://127.0.0.1:8791/voice-ws');
const pcm = fs.readFileSync(__dirname + '/e2e_q.pcm');
let audio = [], t0 = Date.now(), firstAudio = 0, done;
const say = t => out.push(t);
ws.on('open', () => ws.send(JSON.stringify({ setup: { systemText: '你是小学生学习助手,回答简短口语化,最多两句。' } })));
ws.on('message', (m, isBin) => {
  if (isBin) { // 纯音频二进制(网关已把JSON二进制帧转成JSON文本)
    if (!firstAudio) { firstAudio = Date.now() - t0; say('🔊 首段音频: ' + firstAudio + 'ms'); }
    audio.push(m);
    return;
  }
  let j; try { j = JSON.parse(m.toString()); } catch { return; }
  if (j.type === 'ready') {
    say('ready: ' + (Date.now() - t0) + 'ms → 推语音');
    let i = 0;
    const iv = setInterval(() => {
      if (i >= pcm.length) { clearInterval(iv); say('推完→发turn_complete'); ws.send(JSON.stringify({client_content:{turn_complete:true}})); setTimeout(finish, 15000); return; }
      ws.send(pcm.subarray(i, i + 3200)); i += 3200;
    }, 100);
    return;
  }
  if (j.type === 'error') { say('错误: ' + j.message); return finish(); }
  const sc = j.serverContent;
  if (sc) {
    if (sc.inputTranscription && sc.inputTranscription.text) say('你: ' + sc.inputTranscription.text);
    (sc.modelTurn && sc.modelTurn.parts || []).forEach(p => { if (p.text) say('Gemini: ' + p.text); if (p.inlineData) { if(!firstAudio){firstAudio=Date.now()-t0;say('🔊 首段音频(inline): '+firstAudio+'ms');} audio.push(Buffer.from(p.inlineData.data,'base64')); } });
    if (sc.outputTranscription && sc.outputTranscription.text) say('🗣 ' + sc.outputTranscription.text);
    if (sc.turnComplete) { say('轮次完成: ' + (Date.now() - t0) + 'ms'); setTimeout(finish, 600); }
    if (sc.interrupted) say('(被打断)');
  }
});
ws.on('close', c => { say('连接关闭 code=' + c); finish(); });
ws.on('error', e => { say('WS错误: ' + e.message); finish(); });
setTimeout(() => { say('总超时25s'); finish(); }, 25000);
function finish() {
  if (done) return; done = true;
  try { ws.close(); } catch (e) {}
  const total = Buffer.concat(audio);
  say('音频: ' + (total.length / 2 / 24000).toFixed(1) + '秒 (' + total.length + '字节)');
  if (total.length) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + total.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
    h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(total.length, 40);
    fs.writeFileSync('gemini_reply.wav', Buffer.concat([h, total]));
    say('已存 gemini_reply.wav');
  }
  fs.writeFileSync('selftest_result.txt', out.join('\n'));
}
process.on('exit', () => fs.writeFileSync('selftest_result.txt', out.join('\n')));
