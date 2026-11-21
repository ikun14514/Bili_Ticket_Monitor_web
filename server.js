'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Store } = require('./lib/store');
const { Monitor, STATUS_LABEL } = require('./lib/monitor');
const {
  fetchProject,
  parseProjectId,
  isShortLink,
  resolveShortLink,
  extractProjectId,
  getBiliTicket,
  stockText,
} = require('./lib/bili');
const clock = require('./lib/clock');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store();
const clients = new Set();
const resolveCache = new Map(); // projectId -> { data, at }
let broadcastTimer = null;

/* ---------------- 快照 ---------------- */

function stockOf(s) {
  if (s.status !== 'available') return '';
  if (s.stock) return s.stock;
  if (typeof s.num === 'number') {
    return stockText({ num: s.num, limit: typeof s.limit === 'number' ? s.limit : null });
  }
  return '有票';
}

function publicTarget(t) {
  const s = t.state || {};
  return {
    id: t.id,
    projectId: t.projectId,
    name: t.alias || t.projectName || `项目 ${t.projectId}`,
    projectName: t.projectName,
    screen: t.screenName || '',
    ticket: t.ticketName || '',
    price: t.price || 0,
    status: s.status || 'unknown',
    label: STATUS_LABEL[s.status || 'unknown'] || '待检测',
    num: typeof s.num === 'number' ? s.num : null,
    limit: typeof s.limit === 'number' ? s.limit : null,
    flagNumber: s.flagNumber === undefined ? null : s.flagNumber,
    stock: stockOf(s),
    available: !!s.available,
    stale: !!s.stale,
    silent: !!s.silent,
    pending: s.pending || '',
    checkedAt: s.checkedAt || 0,
    changedAt: s.changedAt || 0,
    saleStart: t.saleStart || 0,
    saleStartText: t.saleStartText || '',
  };
}

function buildCountdown() {
  const now = clock.now();
  let best = null;
  for (const t of store.targets) {
    if (!t.enabled || !t.saleStart) continue;
    const ts = t.saleStart * 1000;
    if (ts <= now + 800) continue;
    if (t.state && t.state.status === 'available') continue;
    if (!best || ts < best.ts) best = { ts, t };
  }
  if (!best) return { active: false, serverNow: now };
  const t = best.t;
  return {
    active: true,
    name: t.alias || t.projectName || `项目 ${t.projectId}`,
    projectName: t.projectName || '',
    screen: t.screenName || '',
    ticket: t.ticketName || '',
    saleAt: t.saleStart,
    saleText: t.saleStartText || '',
    serverNow: now,
  };
}

function publicState(opts = {}) {
  const list = opts.all ? store.targets : store.targets.filter((t) => t.enabled);
  const targets = list.map(publicTarget);
  const logs = store.logs.slice(-40).map((l) => ({
    t: l.t,
    time: l.time,
    level: l.level,
    text: l.text,
  }));
  const st = store.settings;
  return {
    now: clock.now(),
    clock: clock.status(),
    running: !!store.state.running,
    title: st.title,
    subtitle: st.subtitle,
    theme: st.theme,
    showLog: st.liveShowLog,
    logLines: st.liveLogLines,
    sound: st.liveSound,
    interval: st.interval,
    stats: {
      total: targets.length,
      available: targets.filter((t) => t.available).length,
    },
    targets,
    logs,
    countdown: buildCountdown(),
    engine: {
      phase: monitor.status.phase,
      phaseLabel: monitor.status.phaseLabel,
      interval: monitor.status.interval,
      projects: monitor.status.projects,
      requests: monitor.status.requests,
      quiet: !!st.quiet,
      warmupSeconds: st.warmupSeconds,
      risk: monitor.status.risk,
      avoidance: monitor.status.avoidance,
    },
    monitor: monitor.status,
  };
}

function adminState() {
  const st = store.settings;
  return {
    ...publicState({ all: true }),
    logs: store.logs.slice(-200),
    settings: {
      title: st.title,
      subtitle: st.subtitle,
      interval: st.interval,
      cookie: st.cookie,
      adminKey: st.adminKey,
      autostart: st.autostart,
      liveSound: st.liveSound,
      liveShowLog: st.liveShowLog,
      liveLogLines: st.liveLogLines,
      theme: st.theme,
      rushInterval: st.rushInterval,
      watchInterval: st.watchInterval,
      watchMinutes: st.watchMinutes,
      steadyInterval: st.steadyInterval,
      pendingInterval: st.pendingInterval,
      warmupSeconds: st.warmupSeconds,
      quiet: st.quiet,
      adaptivePacing: st.adaptivePacing,
      riskCircuitBreaker: st.riskCircuitBreaker,
      saleAvoid: st.saleAvoid,
      avoidMinutes: st.avoidMinutes,
    },
    risk: monitor.status.risk,
    adaptive: monitor.status.adaptive,
    avoidance: monitor.status.avoidance,
    targets: store.targets.map((t) => ({
      ...publicTarget(t),
      projectId: t.projectId,
      screenId: t.screenId,
      ticketId: t.ticketId,
      enabled: t.enabled,
      alias: t.alias || '',
      screenStart: t.screenStart || '',
      flagName: (t.state && t.state.flagName) || '',
    })),
  };
}

/* ---------------- SSE ---------------- */

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    /* ignore */
  }
}

function broadcastState() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (!clients.size) return;
    const payload = publicState();
    for (const res of clients) sseSend(res, 'state', payload);
  }, 300);
}

const monitor = new Monitor(store, {
  onUpdate: broadcastState,
  onLog: (entry) => {
    const payload = { t: entry.t, time: entry.time, level: entry.level, text: entry.text };
    for (const res of clients) sseSend(res, 'log', payload);
  },
});

/* ---------------- HTTP 帮助函数 ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthed(req, url) {
  const key = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  return String(key) === String(store.settings.adminKey);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function html(res, file) {
  serveFile(res, path.join(PUBLIC_DIR, file));
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* 公开 */
  if (p === '/api/live/state') return json(res, 200, publicState());

  if (p === '/api/live/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    sseSend(res, 'state', publicState());
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        /* ignore */
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
    });
    return;
  }

  /* 管理登录校验 */
  if (p === '/api/admin/login') {
    const body = await readBody(req);
    if (String(body.key || '') === String(store.settings.adminKey)) {
      return json(res, 200, { ok: true });
    }
    return json(res, 401, { ok: false, error: '口令错误' });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAuthed(req, url)) return json(res, 401, { ok: false, error: '未授权' });

    if (p === '/api/admin/state' && method === 'GET') return json(res, 200, adminState());

    if (p === '/api/admin/settings' && method === 'POST') {
      const body = await readBody(req);
      const prev = { ...store.settings };
      const next = store.updateSettings(body);

      // 只有影响调度节奏的字段变化才重算；改标题/口令等不打断监控、不多发请求
      const PACE_LABEL = {
        rushInterval: '开售轮询', watchInterval: '回流间隔', watchMinutes: '回流时长',
        steadyInterval: '有票观察', pendingInterval: '待开售间隔',
        warmupSeconds: '开售前预热', quiet: '开售前静默', cookie: 'Cookie',
        adaptivePacing: '自适应节流', saleAvoid: '开售避让', avoidMinutes: '开售避让窗口',
      };
      const changed = Object.keys(PACE_LABEL).filter((k) => prev[k] !== next[k]);
      if (changed.length) monitor.reconfigure(changed.map((k) => PACE_LABEL[k]));
      // 熔断被关闭时清掉残留冷却等级，否则旧 hits 仍会继续拉长间隔
      if (prev.riskCircuitBreaker !== next.riskCircuitBreaker && !next.riskCircuitBreaker) {
        monitor.risk.hits = 0;
        monitor.risk.until = 0;
        monitor.risk.recoverUntil = 0;
        monitor.reconfigure(['412 熔断']);
      }

      // 数值被安全范围钳制时明确回告，避免界面回填后用户以为「改了没生效」
      const NUM_LABEL = {
        rushInterval: '开售后(ms)', watchInterval: '售罄后(ms)', watchMinutes: '回流时长(分)',
        steadyInterval: '有票观察(ms)', pendingInterval: '待开售(秒)', warmupSeconds: '开售前预热(秒)',
        avoidMinutes: '开售避让(分)',
      };
      const adjusted = [];
      for (const [k, label] of Object.entries(NUM_LABEL)) {
        if (body[k] !== undefined && Number(body[k]) !== next[k]) {
          adjusted.push(`${label} → ${next[k]}`);
        }
      }

      monitor.log('system', changed.length ? '配置已保存 · 监控节奏已按新参数重算' : '配置已保存');
      broadcastState();
      return json(res, 200, { ok: true, settings: next, adjusted });
    }

    if (p === '/api/admin/resolve' && method === 'GET') {
      const raw = (url.searchParams.get('id') || '').trim();
      if (!raw) return json(res, 400, { ok: false, error: '请输入项目链接、b23 短链或数字 ID' });
      let projectId = parseProjectId(raw);
      let resolvedFrom = null;
      // b23.tv / b23.cn 短链：展开 302 → 最终链接 → 提取项目 ID
      if (isShortLink(raw)) {
        try {
          const r = await resolveShortLink(raw);
          resolvedFrom = { short: r.short || raw, url: r.url, hops: r.hops };
          projectId = extractProjectId(r);
        } catch (e) {
          return json(res, 200, { ok: false, error: `短链解析失败：${e.message}` });
        }
      }
      if (!projectId) {
        return json(res, 200, {
          ok: false,
          error: resolvedFrom
            ? `短链已展开为 ${resolvedFrom.url}，但没找到会员购项目 ID（可能不是会员购项目页）`
            : '无法识别项目 ID，请粘贴详情页链接、b23 短链或数字 ID',
          resolvedFrom,
        });
      }
      try {
        const data = await fetchProject(projectId, store.settings.cookie);
        resolveCache.set(projectId, { data, at: Date.now() });
        return json(res, 200, { ok: true, project: data, resolvedFrom });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, resolvedFrom });
      }
    }

    if (p === '/api/admin/targets' && method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json(res, 400, { ok: false, error: '未选择票档' });
      const projectId = String(body.projectId || items[0].projectId || '');
      let project = resolveCache.get(projectId);
      if (!project || Date.now() - project.at > 10 * 60 * 1000) {
        try {
          const data = await fetchProject(projectId, store.settings.cookie);
          project = { data, at: Date.now() };
          resolveCache.set(projectId, project);
        } catch (e) {
          return json(res, 200, { ok: false, error: `拉取项目失败：${e.message}` });
        }
      }
      const data = project.data;
      const screenMap = new Map(data.screens.map((s) => [s.id, s]));
      const alias = (body.alias || '').slice(0, 40);

      const toAdd = [];
      for (const it of items) {
        const screen = screenMap.get(String(it.screenId));
        if (!screen) continue;
        const tk = screen.tickets.find((x) => x.id === String(it.ticketId));
        if (!tk) continue;
        toAdd.push({
          projectId,
          screenId: screen.id,
          ticketId: tk.id,
          projectName: data.name,
          screenName: screen.name,
          ticketName: tk.desc,
          price: tk.price,
          saleStart: tk.saleStartTs || data.saleStartTs || 0,
          saleStartText: tk.saleStartTs
            ? new Date((tk.saleStartTs + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ')
            : '',
          alias,
        });
      }
      if (!toAdd.length) return json(res, 400, { ok: false, error: '票档不存在于该项目中' });
      const added = store.addTargets(toAdd);
      for (const t of added) {
        monitor.log('system', `已添加监控：${t.projectName} · ${t.screenName} · ${t.ticketName}`);
      }
      if (!monitor.running) monitor.start();
      broadcastState();
      return json(res, 200, { ok: true, added: added.length, skipped: toAdd.length - added.length });
    }

    const mTarget = p.match(/^\/api\/admin\/targets\/([\w-]+)$/);
    if (mTarget) {
      const id = mTarget[1];
      const t = store.getTarget(id);
      if (!t) return json(res, 404, { ok: false, error: '目标不存在' });
      if (method === 'DELETE') {
        store.removeTarget(id);
        monitor.log('system', `已移除监控：${t.projectName} · ${t.ticketName}`);
        broadcastState();
        return json(res, 200, { ok: true });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (body.enabled !== undefined) t.enabled = !!body.enabled;
        if (typeof body.alias === 'string') t.alias = body.alias.slice(0, 40);
        store.saveSoon();
        broadcastState();
        return json(res, 200, { ok: true });
      }
    }

    // 项目总开关：批量启用/停用某项目 ID 下所有票档，并即时同步 worker
    const mProject = p.match(/^\/api\/admin\/projects\/([\w-]+)$/);
    if (mProject && method === 'PATCH') {
      const pid = mProject[1];
      const inProj = store.targets.filter((t) => t.projectId === pid);
      if (!inProj.length) return json(res, 404, { ok: false, error: '项目不存在' });
      const body = await readBody(req);
      if (body.enabled !== undefined) {
        const on = !!body.enabled;
        const n = store.setProjectEnabled(pid, on);
        monitor.sync();
        monitor.log('system', `项目 ${pid} 的 ${n} 个票档已${on ? '全部启用' : '全部停用'}`);
      }
      broadcastState();
      return json(res, 200, {
        ok: true,
        enabled: inProj.every((t) => t.enabled),
        partial: inProj.some((t) => t.enabled) && !inProj.every((t) => t.enabled),
      });
    }

    const mCheck = p.match(/^\/api\/admin\/targets\/([\w-]+)\/check$/);
    if (mCheck && method === 'POST') {
      const r = await monitor.checkTarget(mCheck[1]);
      broadcastState();
      return json(res, 200, r);
    }

    if (p === '/api/admin/monitor' && method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'start') monitor.start();
      else if (body.action === 'stop') monitor.stop();
      broadcastState();
      return json(res, 200, { ok: true, running: monitor.running });
    }

    // 412 风控：一键开关全局熔断 / 手动解除冷却
    if (p === '/api/admin/risk' && method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'breaker') {
        monitor.setCircuitBreaker(!!body.enabled);
        broadcastState();
        return json(res, 200, {
          ok: true,
          enabled: store.settings.riskCircuitBreaker,
          risk: monitor.status.risk,
        });
      }
      if (body.action === 'clear') {
        monitor.clearRisk();
        broadcastState();
        return json(res, 200, { ok: true, risk: monitor.status.risk, adaptive: monitor.status.adaptive });
      }
      return json(res, 400, { ok: false, error: '未知操作' });
    }

    if (p === '/api/admin/ntp' && method === 'POST') {
      const r = await monitor.syncClock('手动校时');
      return json(res, 200, { ok: !!r, clock: clock.status(), error: r ? undefined : clock.status().error });
    }

    if (p === '/api/admin/logs/clear' && method === 'POST') {
      store.clearLogs();
      broadcastState();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/test-alert' && method === 'POST') {
      const body = await readBody(req);
      const t = store.targets.find((x) => x.id === body.targetId) || store.targets[0];
      if (!t) return json(res, 400, { ok: false, error: '请先添加监控目标' });
      monitor.log('alert', `【有票】${t.alias || t.projectName} 余票 2 张（测试）`, {
        targetId: t.id,
        test: true,
      });
      broadcastState();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/ticket' && method === 'GET') {
      try {
        const tk = await getBiliTicket(store.settings.cookie, true);
        return json(res, 200, {
          ok: true,
          cached: tk.cached,
          exp: tk.exp,
          expText: new Date((tk.exp + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' '),
          ticket: tk.ticket,
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }

    return json(res, 404, { ok: false, error: '接口不存在' });
  }

  return json(res, 404, { ok: false, error: 'Not Found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,x-admin-key',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    });
    return res.end();
  }

  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (p === '/health' || p === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

    if (p === '/' || p === '/live') return html(res, 'live.html');
    if (p === '/admin' || p === '/admin.html') return html(res, 'admin.html');

    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveFile(res, filePath);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`余票监控已启动: http://0.0.0.0:${PORT}  (管理页 /admin)`);
  if (store.settings.autostart && store.targets.length) {
    monitor.start();
  } else if (store.targets.length) {
    store.state.running = false;
  }
  // 预热 bili_ticket，失败不影响启动
  getBiliTicket(store.settings.cookie)
    .then((tk) => console.log(`bili_ticket 就绪，有效期至 ${new Date(tk.exp * 1000).toISOString()}`))
    .catch((e) => console.warn('bili_ticket 预热失败:', e.message));
});

process.on('SIGTERM', () => {
  monitor.stop(true);
  // SSE / keep-alive 长连接会让 server.close() 永远挂着，主动断开并加超时兜底
  const force = setTimeout(() => process.exit(0), 1500);
  force.unref();
  server.close(() => { clearTimeout(force); process.exit(0); });
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
});
