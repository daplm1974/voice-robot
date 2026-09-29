// config.js — 前端唯一配置点: 后端地址
// 独立部署时改为后端IP, 如 'http://192.168.5.155:8791'; 空串=同源
window.ROBOT_CONFIG = {
  backend: '',            // '' = 与页面同源(由后端静态托管时)
  defaultMode: 'chat',    // 启动模式: chat | monitor
};
