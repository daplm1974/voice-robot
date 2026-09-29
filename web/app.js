// app.js — 学习养成助手前端(纯静态, 与后端CORS通信)
(function () {
  'use strict';
  const CFG = window.ROBOT_CONFIG || { backend: '', defaultMode: 'chat' };
  const HOST = CFG.backend || location.host;               // 后端主机(端口)
  const HTTP = CFG.backend || '';                            // 同源时用相对路径
  const $ = id => document.getElementById(id);
  const log = (t, c) => { const d = document.createElement('div'); d.className = c; d.textContent = t; $('log').appendChild(d); $('log').scrollTop = 1e9; };

  // ---------- 状态 ----------
  let ws = null, audioCtx = null, source = null, processor = null, stream = null, running = false;
  let playCtx = null, nextTime = 0;
  let camStream = null, camTimer = null, lastVision = null, monitorTimer = null, lastMonitorAt = 0;
  let mode = 'chat';
  let vadSpeaking = false, vadVoiceMs = 0, vadLastVoice = 0, vadLastSent = 0, botSpeaking = false, bargeMs = 0;
  let lastUserText = '';
  const VAD_THRES = 0.04, VAD_TAIL = 1200, VAD_MIN_VOICE = 300, BARGE_THRES = 0.08, BARGE_MS = 400;
  const VISION_FRESH = 12000;
  const VISION_WORDS = /这题|这道|卷子|试卷|纸上|看看|这个|那个|哪里|多少|写的|写的|错哪/;
  const playing = new Set();

  // ---------- 模式 ----------
  function setMode(m, announce) {
    if (m === mode) return;
    mode = m;
    $('modeLamp').textContent = m === 'monitor' ? '● 监控模式' : '● 聊天模式';
    $('modeLamp').className = m === 'monitor' ? 'monitor' : '';
    $('monitorChk').checked = m === 'monitor';
    log(m === 'monitor' ? '🟣 已切换到监控模式(实时监督学习)' : '⚪ 已切换到聊天模式', 'sys');
    if (m === 'monitor') startMonitorLoop(); else stopMonitorLoop();
    if (announce) fetch(HTTP + '/modes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) }).catch(function () {});
  }

  // ---------- 摄像头 ----------
  async function startCamera() {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 2560 }, height: { ideal: 1440 } } });
      $('camVideo').srcObject = camStream;
      $('camPanel').style.display = 'block';
      $('snap').disabled = false;
      $('visionInfo').textContent = '摄像头已开启(聊天模式: 仅按需识别)';
    } catch (e) { $('visionInfo').textContent = '摄像头开启失败: ' + e.message; }
  }
  function stopCamera() {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    $('camPanel').style.display = 'none';
    lastVision = null;
  }
  async function grabFrame(width, quality) {
    const v = $('camVideo');
    if (!v.videoWidth) return null;
    const W = Math.min(width, v.videoWidth);
    const c = document.createElement('canvas');
    c.width = W; c.height = Math.round(v.videoHeight * W / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality).split(',')[1];
  }
  async function describe(mode_, width, quality) {
    const b64 = await grabFrame(width, quality);
    if (!b64) return null;
    try {
      const r = await fetch(HTTP + '/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: b64, mode: mode_ }) });
      const j = await r.json();
      return j.description || null;
    } catch (e) { return null; }
  }

  // ---------- 监控循环(自适应: 上一帧完成+1s再发) ----------
  function startMonitorLoop() {
    if (monitorTimer) return;
    const loop = async function () {
      if (mode !== 'monitor' || !camStream) return;
      const intervalMs = Date.now() - lastMonitorAt;
      lastMonitorAt = Date.now();
      try {
        const b64 = await grabFrame(640, 0.6);
        if (b64) {
          $('visionInfo').textContent = '👁 分析中…';
          const r = await fetch(HTTP + '/vision', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Interval-Ms': String(intervalMs) }, body: JSON.stringify({ image: b64, mode: 'monitor' }) });
          const j = await r.json();
          if (j.state) {
            lastVision = { text: '正在' + j.state.doing + ',进度:' + j.state.progress + ',专注:' + j.state.focus, at: Date.now() };
            $('visionInfo').textContent = '👁 ' + j.state.doing + ' | ' + j.state.progress + ' | 专注:' + j.state.focus + ' | ' + j.state.anomaly;
          } else $('visionInfo').textContent = '👁 ' + (j.description || '分析失败').slice(0, 50);
        }
      } catch (e) { /* 下轮再试 */ }
      monitorTimer = setTimeout(loop, 1000);
    };
    lastMonitorAt = Date.now();
    monitorTimer = setTimeout(loop, 500);
  }
  function stopMonitorLoop() {
    if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  }

  // ---------- 播放 ----------
  function playChunk(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    const buf = playCtx.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    const node = playCtx.createBufferSource();
    node.buffer = buf;
    node.connect(playCtx.destination);
    node.onended = function () { playing.delete(node); };
    playing.add(node);
    const now = playCtx.currentTime;
    if (nextTime < now) nextTime = now + 0.02;
    node.start(nextTime);
    nextTime += buf.duration;
  }
  function stopPlayback() {
    playing.forEach(a => { try { a.stop(); } catch (e) { /* noop */ } });
    playing.clear();
    nextTime = 0;
  }

  // ---------- 语音会话 ----------
  async function start() {
    $('start').disabled = true; running = true;
    try {
      playCtx = new AudioContext({ sampleRate: 24000 });
      nextTime = 0;
      ws = new WebSocket('ws://' + HOST + '/voice-ws');
      ws.binaryType = 'arraybuffer';
      ws.onopen = async function () {
        $('status').textContent = '握手中...';
        ws.send(JSON.stringify({ setup: { systemText: $('persona').value, voice: $('voice').value } }));
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, sampleRate: 16000, channelCount: 1 }
        });
        audioCtx = new AudioContext({ sampleRate: 16000 });
        source = audioCtx.createMediaStreamSource(stream);
        processor = audioCtx.createScriptProcessor(1024, 1, 1);
        processor.onaudioprocess = onAudio;
        source.connect(processor); processor.connect(audioCtx.destination);
        if ($('cam').checked) startCamera();
      };
      ws.onmessage = function (e) { handle(e.data); };
      ws.onclose = function () { $('status').textContent = '已断开'; if (running) stop(); };
    } catch (e) { log('启动失败: ' + e.message, 'sys'); stop(); }
  }

  function onAudio(e) {
    if (!running || !ws || ws.readyState !== 1) return;
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    let sum = 0;
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      sum += f[i] * f[i];
    }
    const rms = Math.sqrt(sum / f.length);
    meter(rms);
    // 半双工: 播报期间不推流, 检测强插话
    if (botSpeaking) {
      if (rms > BARGE_THRES) {
        bargeMs += (f.length / 16000) * 1000;
        if (bargeMs >= BARGE_MS) {
          bargeMs = 0; stopPlayback(); botSpeaking = false;
          vadSpeaking = true; vadVoiceMs = VAD_MIN_VOICE; vadLastVoice = Date.now();
          log('(插话→停播,请继续说)', 'sys');
        }
      } else bargeMs = 0;
      vadSpeaking = false; vadVoiceMs = 0;
      return;
    }
    ws.send(pcm.buffer);
    const now = Date.now();
    if (rms > VAD_THRES) { vadSpeaking = true; vadVoiceMs += (f.length / 16000) * 1000; vadLastVoice = now; }
    else if (vadSpeaking && vadVoiceMs >= VAD_MIN_VOICE && now - vadLastVoice > VAD_TAIL) {
      vadSpeaking = false; vadVoiceMs = 0;
      sendTurnComplete();
    }
  }

  async function sendTurnComplete() {
    if (!ws || ws.readyState !== 1 || Date.now() - vadLastSent <= 1500) return;
    vadLastSent = Date.now();
    let visionTurn = null;
    if ($('cam').checked) {
      let text = null, tag = '画面';
      if (lastUserText && VISION_WORDS.test(lastUserText)) {
        $('visionInfo').textContent = '📖 正在精读卷面…';
        text = await Promise.race([describe('read', 2560, 0.8), new Promise(r => setTimeout(() => r(null), 9000))]);
        tag = '卷面内容';
      }
      if (!text && lastVision && Date.now() - lastVision.at < VISION_FRESH) { text = lastVision.text; tag = '当前画面'; }
      if (text) visionTurn = [{ role: 'user', parts: [{ text: '(' + tag + ': ' + text + ')' }] }];
    }
    ws.send(JSON.stringify({ client_content: { turns: visionTurn || [], turn_complete: true } }));
    log('(说完→已通知' + (visionTurn ? '+带' + (visionTurn[0].parts[0].text.indexOf('卷面') >= 0 ? '卷面精读' : '画面') : '') + ')', 'sys');
  }

  function handle(data) {
    if (data instanceof ArrayBuffer) return;
    let j; try { j = JSON.parse(data); } catch (e) { return; }
    if (j.type === 'ready') { $('status').textContent = '● 对话中(' + (mode === 'monitor' ? '监控' : '聊天') + ')'; log('已就绪,请说话', 'sys'); return; }
    if (j.type === 'mode') { setMode(j.mode, false); return; }
    if (j.type === 'status') { $('status').textContent = '⟳ ' + (j.text || ''); return; }
    if (j.type === 'error') { log('错误: ' + (j.message || ''), 'sys'); return; }
    if (j.transcription) {
      const tin = j.transcription.inputTranscription && j.transcription.inputTranscription.text;
      const tout = j.transcription.outputTranscription && j.transcription.outputTranscription.text;
      if (tin) { lastUserText = (lastUserText + tin).slice(-100); log('你: ' + tin, 'you'); }
      if (tout) log('🗣 ' + tout, 'bot');
      return;
    }
    const sc = j.serverContent;
    if (!sc) return;
    const anyAudio = (sc.serverAudio && sc.serverAudio.data) ||
      (sc.modelTurn && sc.modelTurn.parts || []).some(function (p) { return p.inlineData; });
    if (anyAudio) botSpeaking = true;
    if (sc.serverAudio && sc.serverAudio.data) playChunk(sc.serverAudio.data);
    (sc.modelTurn && sc.modelTurn.parts || []).forEach(function (p) {
      if (p.text) log(p.text, 'bot');
      if (p.inlineData) playChunk(p.inlineData.data);
    });
    if (sc.inputTranscription && sc.inputTranscription.text) log('你: ' + sc.inputTranscription.text, 'you');
    if (sc.outputTranscription && sc.outputTranscription.text && !sc.modelTurn) log('🗣 ' + sc.outputTranscription.text, 'bot');
    if (sc.turnComplete) { botSpeaking = false; lastUserText = ''; log('— 轮次完成 —', 'sys'); }
    if (sc.interrupted) { botSpeaking = false; log('(被打断)', 'sys'); }
  }

  function meter(rms) {
    const bar = $('meterBar');
    if (!bar) return;
    bar.style.width = Math.min(100, rms * 500) + '%';
    bar.className = rms > VAD_THRES ? 'hot' : '';
  }

  function stop() {
    running = false;
    $('start').disabled = false; $('stop').disabled = true;
    if (ws && ws.readyState === 1) { try { ws.close(); } catch (e) { /* noop */ } }
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();
    if (playCtx) playCtx.close();
    stopMonitorLoop(); stopCamera();
    $('status').textContent = '未连接';
  }

  // ---------- UI绑定 ----------
  $('start').onclick = function () { $('stop').disabled = false; start(); };
  $('stop').onclick = stop;
  $('snap').onclick = async function () {
    const b64 = await grabFrame(2560, 0.9);
    if (!b64) return log('摄像头未开', 'sys');
    const r = await fetch(HTTP + '/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: b64 }) });
    const j = await r.json();
    log('📷 已存全分辨率照片 → voice-robot/snapshot.jpg (' + j.bytes + 'B)', 'sys');
  };
  $('monitorChk').onchange = function () { setMode(this.checked ? 'monitor' : 'chat', true); };
  setMode(CFG.defaultMode || 'chat', false);
  log('学习养成助手 v4 (前后端分离) | 后端: ' + (CFG.backend || '同源'), 'sys');
})();
