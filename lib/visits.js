'use strict';

/**
 * 访问统计（PV / 独立访客）
 * - 只统计 HTML 页面请求（/、/live、/admin），API、静态资源、健康检查不计入
 * - 独立访客 = IP + User-Agent 的哈希，同一访客全天只算一次
 * - 排除本机回环与常见探针 UA，避免健康检查把数据刷高
 * - 内存累加 + 节流落盘，进程退出时强制刷盘；单进程写入，无并发冲突
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'visits.json');
const MAX_RECENT = 100;
const FLUSH_MS = 2000;

const BOT_RE = /(bot|crawler|spider|probe|kube-probe|healthcheck|uptimerobot|pingdom|monitor|headlesschrome|playwright|selenium|curl|wget|python-requests|go-http-client|ahrefs|semrush)/i;
const LOOPBACK_RE = /^(127\.|::1$|::ffff:127\.|localhost)/i;

function beijingDay(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function beijingTime(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function emptyState() {
  return {
    since: Date.now(),
    pv: 0,
    pvLive: 0,
    pvAdmin: 0,
    probes: 0,
    visitors: {}, // vid -> { first, last, visits }
    days: {},     // YYYY-MM-DD -> { pv, live, admin, visitors: { vid: 1 } }
    recent: [],
  };
}

class Visits {
  constructor() {
    this.state = this.load();
    this.dirty = false;
    this.timer = null;
    const flush = () => this.flush();
    process.on('beforeExit', flush);
    process.on('SIGINT', () => { flush(); process.exit(0); });
    process.on('SIGTERM', () => { flush(); process.exit(0); });
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw.pv === 'number' && raw.visitors && raw.days) return raw;
    } catch (e) { /* 首次运行或文件损坏 */ }
    return emptyState();
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2), 'utf8');
      this.dirty = false;
    } catch (e) {
      console.error('[visits] 落盘失败:', e.message);
    }
  }

  scheduleFlush() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  clientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    let ip = xf ? String(xf).split(',')[0].trim() : '';
    if (!ip) ip = String(req.headers['x-real-ip'] || '');
    if (!ip) ip = String(req.socket?.remoteAddress || '');
    return ip.replace(/^::ffff:/, '');
  }

  /**
   * 记录一次页面访问。仅对 HTML 页面路径调用。
   * @returns {string|null} 页面类型 live / admin，未计入返回 null
   */
  record(req, pathname, url) {
    const page = pathname === '/admin' || pathname === '/admin.html' ? 'admin'
      : (pathname === '/' || pathname === '/live' || pathname === '/live.html') ? 'live'
        : null;
    if (!page) return null;

    const ip = this.clientIp(req);
    const ua = String(req.headers['user-agent'] || '');

    // 本机与探针：单独计数，不污染真实浏览数据
    if (LOOPBACK_RE.test(ip) || (BOT_RE.test(ua) && !/Mozilla/i.test(ua))) {
      this.state.probes += 1;
      this.scheduleFlush();
      return null;
    }
    const ts = Date.now();
    const day = beijingDay(ts);
    const vid = crypto.createHash('sha1').update(ip + '|' + ua).digest('hex').slice(0, 16);

    const st = this.state;
    st.pv += 1;
    if (page === 'live') st.pvLive += 1; else st.pvAdmin += 1;

    const v = st.visitors[vid];
    if (v) { v.last = ts; v.visits += 1; }
    else st.visitors[vid] = { first: ts, last: ts, visits: 1, ip: maskIp(ip), ua: shortUa(ua) };

    const d = st.days[day] || (st.days[day] = { pv: 0, live: 0, admin: 0, visitors: {} });
    d.pv += 1;
    d[page] += 1;
    d.visitors[vid] = 1;

    st.recent.push({ t: ts, time: beijingTime(ts), page, ip: maskIp(ip), ua: shortUa(ua), new: !v });
    if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);

    this.scheduleFlush();
    return page;
  }

  summary() {
    const st = this.state;
    const day = beijingDay(Date.now());
    const today = st.days[day] || { pv: 0, live: 0, admin: 0, visitors: {} };
    const days = Object.keys(st.days).sort().slice(-14).map((k) => ({
      date: k,
      pv: st.days[k].pv,
      uv: Object.keys(st.days[k].visitors || {}).length,
      live: st.days[k].live,
      admin: st.days[k].admin,
    }));
    return {
      ok: true,
      since: st.since,
      sinceText: beijingTime(st.since),
      pv: st.pv,
      uv: Object.keys(st.visitors).length,
      pvLive: st.pvLive,
      pvAdmin: st.pvAdmin,
      today: {
        date: day,
        pv: today.pv,
        uv: Object.keys(today.visitors || {}).length,
        live: today.live,
        admin: today.admin,
      },
      days,
      probes: st.probes,
      recent: st.recent.slice(-20).reverse(),
    };
  }
}

function maskIp(ip) {
  if (!ip) return '未知';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':*';
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.*` : ip;
}

function shortUa(ua) {
  if (!ua) return '未知';
  const m = ua.match(/(Edg|Chrome|Firefox|Safari|OPR|MicroMessenger|WeChat|iPhone|Android|Mobile)\/[\d.]+/);
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS'
    : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Linux/i.test(ua) ? 'Linux' : '';
  return (os ? os + ' · ' : '') + (m ? m[0].replace('OPR', 'Opera') : ua.slice(0, 24));
}

module.exports = new Visits();
