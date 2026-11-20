'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_STATE = {
  settings: {
    title: '余票监控',
    subtitle: 'BILIBILI TICKET MONITOR',
    interval: 5,
    cookie: '',
    adminKey: process.env.ADMIN_KEY || 'admin',
    autostart: true,
    liveSound: false,
    liveShowLog: true,
    liveLogLines: 6,
    theme: 'red',
    // 抢票节奏（毫秒）
    rushInterval: 100,      // 开售后高频
    watchInterval: 500,     // 售罄后刷回流
    watchMinutes: 15,       // 回流高频持续时间
    steadyInterval: 2000,   // 有票后稳定观察
    pendingInterval: 30,    // 未开售时低频确认（秒，静默关闭时生效）
    warmupSeconds: 60,      // 开售前多久开始请求接口（秒）
    quiet: true,            // 开售前静默：到点前完全不发请求
    adaptivePacing: true,   // 412 高峰期自适应拉长轮询间隔（柔性降频，不中断监控）
    riskCircuitBreaker: true, // 412 全局熔断（硬性零请求冷却），可一键关闭
    saleAvoid: true,        // 开售避让：临近开售暂停所有回流监控，给开抢让路（防 IP 拉黑）
    avoidMinutes: 5,        // 提前多少分钟进入开售避让窗口
  },
  running: false,
  targets: [],
  logs: [],
};

function clampInt(v, min, max, dft) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(input, prev) {
  const s = { ...prev };
  if (!input || typeof input !== 'object') return s;
  if (typeof input.title === 'string') s.title = input.title.slice(0, 40) || '余票监控';
  if (typeof input.subtitle === 'string') s.subtitle = input.subtitle.slice(0, 60);
  if (input.interval !== undefined) s.interval = clampInt(input.interval, 2, 300, 5);
  if (typeof input.cookie === 'string') s.cookie = input.cookie.trim().slice(0, 4000);
  if (typeof input.adminKey === 'string' && input.adminKey.trim().length >= 3) {
    s.adminKey = input.adminKey.trim().slice(0, 40);
  }
  if (input.autostart !== undefined) s.autostart = !!input.autostart;
  if (input.liveSound !== undefined) s.liveSound = !!input.liveSound;
  if (input.liveShowLog !== undefined) s.liveShowLog = !!input.liveShowLog;
  if (input.liveLogLines !== undefined) s.liveLogLines = clampInt(input.liveLogLines, 0, 12, 6);
  if (typeof input.theme === 'string' && ['red', 'amber', 'green'].includes(input.theme)) {
    s.theme = input.theme;
  }
  // 下限是防风控硬约束：低于 100ms/200ms 会直接撞 B 站 412，保存时按边界值生效并明确回告
  if (input.rushInterval !== undefined) s.rushInterval = clampInt(input.rushInterval, 100, 5000, 100);
  if (input.watchInterval !== undefined) s.watchInterval = clampInt(input.watchInterval, 200, 10000, 500);
  if (input.watchMinutes !== undefined) s.watchMinutes = clampInt(input.watchMinutes, 0, 240, 15);
  if (input.steadyInterval !== undefined) s.steadyInterval = clampInt(input.steadyInterval, 200, 60000, 2000);
  if (input.pendingInterval !== undefined) s.pendingInterval = clampInt(input.pendingInterval, 1, 600, 30);
  if (input.warmupSeconds !== undefined) s.warmupSeconds = clampInt(input.warmupSeconds, 5, 600, 60);
  if (input.quiet !== undefined) s.quiet = !!input.quiet;
  if (input.adaptivePacing !== undefined) s.adaptivePacing = !!input.adaptivePacing;
  if (input.riskCircuitBreaker !== undefined) s.riskCircuitBreaker = !!input.riskCircuitBreaker;
  if (input.saleAvoid !== undefined) s.saleAvoid = !!input.saleAvoid;
  if (input.avoidMinutes !== undefined) s.avoidMinutes = clampInt(input.avoidMinutes, 1, 30, 5);
  return s;
}

class Store {
  constructor() {
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this._timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(FILE)) {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const base = JSON.parse(JSON.stringify(DEFAULT_STATE));
        this.state = {
          ...base,
          ...raw,
          settings: { ...base.settings, ...(raw.settings || {}) },
          targets: Array.isArray(raw.targets) ? raw.targets : [],
          logs: Array.isArray(raw.logs) ? raw.logs.slice(-300) : [],
        };
        // 老配置迁移：升级为「开售前静默」，把 30 秒预热提升到 1 分钟
        if (!raw.settings || raw.settings.quiet === undefined) {
          this.state.settings.quiet = true;
          if (!raw.settings || !raw.settings.warmupSeconds || raw.settings.warmupSeconds <= 30) {
            this.state.settings.warmupSeconds = 60;
          }
          this.save();
        }
      }
    } catch (e) {
      console.error('[store] 读取失败，使用默认配置:', e.message);
    }
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        fs.renameSync(tmp, FILE);
      } catch (e) {
        console.error('[store] 写入失败:', e.message);
      }
    }, 400);
  }

  get settings() {
    return this.state.settings;
  }

  get targets() {
    return this.state.targets;
  }

  get logs() {
    return this.state.logs;
  }

  updateSettings(patch) {
    this.state.settings = sanitizeSettings(patch, this.state.settings);
    this.save();
    return this.state.settings;
  }

  addLog(entry) {
    this.state.logs.push(entry);
    if (this.state.logs.length > 300) this.state.logs.splice(0, this.state.logs.length - 300);
    this.save();
    return entry;
  }

  clearLogs() {
    this.state.logs = [];
    this.save();
  }

  getTarget(id) {
    return this.state.targets.find((t) => t.id === id) || null;
  }

  addTargets(list) {
    const added = [];
    for (const item of list) {
      const dup = this.state.targets.find(
        (t) => t.projectId === item.projectId && t.ticketId === item.ticketId
      );
      if (dup) continue;
      const target = {
        id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        projectId: String(item.projectId),
        screenId: String(item.screenId || ''),
        ticketId: String(item.ticketId),
        projectName: item.projectName || '',
        screenName: item.screenName || '',
        ticketName: item.ticketName || '',
        alias: (item.alias || '').slice(0, 40),
        price: item.price || 0,
        saleStart: item.saleStart || 0,
        saleStartText: item.saleStartText || '',
        enabled: true,
        createdAt: Date.now(),
        state: {
          status: 'unknown',
          num: null,
          flagName: '',
          available: false,
          checkedAt: 0,
          changedAt: 0,
          price: item.price || 0,
        },
      };
      this.state.targets.push(target);
      added.push(target);
    }
    this.save();
    return added;
  }

  removeTarget(id) {
    const i = this.state.targets.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.state.targets.splice(i, 1);
    this.save();
    return true;
  }

  /** 项目总开关：批量启用/停用某项目 ID 下的所有票档，返回受影响数量 */
  setProjectEnabled(projectId, enabled) {
    let n = 0;
    for (const t of this.state.targets) {
      if (t.projectId === projectId) {
        t.enabled = !!enabled;
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }

  saveSoon() {
    this.save();
  }
}

module.exports = { Store, DEFAULT_STATE };
