/** supervisor.ts — 监控模式状态机(去抖计数 → 主动播报指令)
 * 前端monitor模式每帧POST /vision, 服务端在响应里附带播报指令;
 * gemini-live通道执行 injectSystem() 播报。
 */

export type Mode = 'chat' | 'monitor';

export interface MonitorObservation {
  doing: string;
  progress: string;
  focus: string;
  anomaly: string;
  intervalMs: number;   // 本帧与上帧间隔(调用方提供)
}

export type ProactiveCmd =
  | { kind: 'none' }
  | { kind: 'remind-away'; text: string }      // 离席提醒
  | { kind: 'remind-focus'; text: string }     // 专注提醒
  | { kind: 'praise-done'; text: string };     // 任务完成祝贺

const AWAY_MS = 120_000;        // 离席持续>2分钟
const LOW_FOCUS_STREAK = 3;     // 低专注连续3帧
const REMIND_COOLDOWN = 300_000;// 同类提醒冷却5分钟

export function createSupervisor() {
  let mode: Mode = 'chat';
  let awayMs = 0;
  let lowFocusStreak = 0;
  let lastRemindAt: Record<string, number> = {};
  let lastProgress = '';

  function setMode(m: Mode): Mode {
    if (m === mode) return mode;
    mode = m;
    awayMs = 0; lowFocusStreak = 0; lastRemindAt = {}; lastProgress = '';
    return mode;
  }

  function getMode(): Mode { return mode; }

  function observe(o: MonitorObservation): ProactiveCmd {
    if (mode !== 'monitor') return { kind: 'none' };
    const now = Date.now();
    // 离席累计
    awayMs = o.anomaly === 'away' ? awayMs + o.intervalMs : 0;
    // 低专注连击
    lowFocusStreak = o.focus === 'low' ? lowFocusStreak + 1 : 0;
    // 任务完成(进度文本变化且含完成词)
    const doneWords = /完成|写完|做完|全对|检查完/;
    const taskDone = doneWords.test(o.progress) && o.progress !== lastProgress;
    if (o.progress) lastProgress = o.progress;

    const cooled = (k: string) => !lastRemindAt[k] || now - lastRemindAt[k] > REMIND_COOLDOWN;

    if (awayMs >= AWAY_MS && cooled('away')) {
      lastRemindAt['away'] = now; awayMs = 0;
      return { kind: 'remind-away', text: '孩子已离席超过两分钟,请温和呼唤回桌继续任务' };
    }
    if (lowFocusStreak >= LOW_FOCUS_STREAK && cooled('focus')) {
      lastRemindAt['focus'] = now; lowFocusStreak = 0;
      return { kind: 'remind-focus', text: '孩子连续几帧分心了,请用有趣的方式把注意力拉回学习任务' };
    }
    if (taskDone && cooled('done')) {
      lastRemindAt['done'] = now;
      return { kind: 'praise-done', text: '孩子似乎完成了当前学习任务(' + o.progress + '),请热情祝贺并提议休息或下一项' };
    }
    return { kind: 'none' };
  }

  return { setMode, getMode, observe };
}
