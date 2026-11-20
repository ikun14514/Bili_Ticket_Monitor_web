'use strict';

/**
 * bilibili 会员购（show.bilibili.com）余票查询封装
 * bili_ticket 算法参考:
 * https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/bili_ticket.md
 *
 * 算法:
 *   1. ts = 当前 UNIX 秒
 *   2. hexsign = hmac_sha256(key='XgwSnGZ1p', msg='ts'+ts)
 *   3. POST https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket
 *      ?key_id=ec02&hexsign=...&context[ts]=...&csrf=<bili_jct>
 *   4. 取 data.ticket 写入 Cookie: bili_ticket=...
 */

const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TICKET_URL =
  'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';

/** bili_ticket 内存缓存 { value, exp(秒), createdAt } */
const ticketCache = { value: '', exp: 0, createdAt: 0 };

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function parseCookie(str) {
  const out = {};
  String(str || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
  return out;
}

function buildCookie(cookieStr, ticket) {
  const jar = parseCookie(cookieStr);
  if (ticket) jar.bili_ticket = ticket;
  return Object.keys(jar)
    .map((k) => `${k}=${jar[k]}`)
    .join('; ');
}

/**
 * 获取 bili_ticket（带缓存，提前 1 小时刷新）
 * @returns {Promise<{ticket:string, exp:number, cached:boolean}>}
 */
async function getBiliTicket(cookieStr, force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && ticketCache.value && ticketCache.exp - 3600 > now) {
    return { ticket: ticketCache.value, exp: ticketCache.exp, cached: true };
  }
  const ts = now;
  const hexsign = hmacSha256('XgwSnGZ1p', `ts${ts}`);
  const csrf = parseCookie(cookieStr).bili_jct || '';
  const qs = new URLSearchParams({
    key_id: 'ec02',
    hexsign,
    'context[ts]': String(ts),
    csrf,
  });

  const res = await fetch(`${TICKET_URL}?${qs.toString()}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`bili_ticket HTTP ${res.status}`);
  const json = await res.json();
  if (!json || json.code !== 0 || !json.data || !json.data.ticket) {
    throw new Error(`bili_ticket 获取失败: code=${json && json.code} ${json && json.message}`);
  }
  ticketCache.value = json.data.ticket;
  ticketCache.createdAt = json.data.created_at || ts;
  ticketCache.exp = ticketCache.createdAt + (json.data.ttl || 259200);
  return { ticket: ticketCache.value, exp: ticketCache.exp, cached: false };
}

/** 从任意文本中解析 project_id（支持详情页链接 / hash 路由 / 分享文案 / 纯数字） */
function parseProjectId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  // ?id= / &project_id= / #/detail?id= / 转义后的 &amp;id=
  const m = raw.match(/[?&#;](?:amp;)?(?:id|project_id|projectId|projectid)=(\d{4,})/i);
  if (m) return m[1];
  // 路径形式 /detail/123456、/project/123456
  const p = raw.match(/\/detail(?:_new)?\/(\d{4,})/i) || raw.match(/\/(?:project|ticket|activity)\/(\d{4,})/i);
  if (p) return p[1];
  // 分享文案 / JSON 片段里的 "project_id": 123456
  const j = raw.match(/"?(?:project_id|projectId)"?\s*[:=]\s*"?(\d{4,})/i);
  if (j) return j[1];
  const n = raw.match(/(\d{5,})/);
  return n ? n[1] : '';
}

/* ---------------- b23 短链解析 ---------------- */

/** B 站短链域名（会员购分享常见 b23.tv / b23.cn） */
const SHORT_HOST_RE = /^(?:www\.)?(?:b23\.tv|b23\.cn|bili2233\.cn|bili2233\.net|bili\.cn|dwz\.cn)$/i;

/** 从分享文案（可能夹中文）里抠出第一条 URL / 裸短链 */
function findShortUrl(text) {
  const raw = String(text || '').trim();
  if (!/b23|bili2233|bili\.cn|dwz\.cn/i.test(raw)) return '';
  const m =
    raw.match(/https?:\/\/[^\s\u4e00-\u9fa5"'<>）)]+/i) ||
    raw.match(/(?:b23\.tv|b23\.cn|bili2233\.cn|bili2233\.net|bili\.cn|dwz\.cn)\/[A-Za-z0-9_-]+/i);
  return m ? m[0].replace(/[.,;，。；]+$/, '') : '';
}

function isShortLink(input) {
  const raw = findShortUrl(input);
  if (!raw) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return SHORT_HOST_RE.test(u.hostname);
  } catch (e) {
    return false;
  }
}

const shortCache = new Map(); // shortUrl -> { url, html, hops, at }

/**
 * 展开 b23 短链，返回最终 URL。
 * 逐跳跟随 302 Location；对用 JS / meta refresh 跳转的落地页，从 HTML 里提取目标。
 * 最多跟 6 跳，单跳 8s 超时。
 */
async function resolveShortLink(input) {
  let raw = findShortUrl(input) || String(input || '').trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  const hit = shortCache.get(raw);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;

  let cur = raw;
  let html = '';
  let hops = 0;
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    let res;
    try {
      res = await fetch(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      throw new Error(`短链请求失败：${e.message}`);
    }
    const loc = res.headers.get('location');
    if (loc) {
      hops += 1;
      cur = new URL(loc, cur).toString();
      // 已经落到会员购详情页就可以停了
      if (/show\.bilibili\.com/i.test(cur) && parseProjectId(cur)) break;
      continue;
    }
    if (res.ok) {
      html = await res.text().catch(() => '');
      const jump =
        html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+(?:url|content)\s*=\s*["']?([^"'\s>;]+)/i) ||
        html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
        html.match(/(?:url|jumpUrl|targetUrl)\s*[:=]\s*["'](https?:[^"']+)["']/i);
      if (jump && jump[1]) {
        hops += 1;
        cur = new URL(jump[1].replace(/&amp;/g, '&'), cur).toString();
        if (/show\.bilibili\.com/i.test(cur) && parseProjectId(cur)) break;
        continue;
      }
    }
    break;
  }
  const out = { short: raw, url: cur, html, hops, at: Date.now() };
  shortCache.set(raw, out);
  return out;
}

/** 从短链最终落地页里提取项目 ID：只认强特征，避免把视频 aid / 时间戳误当项目 ID */
function extractProjectId(resolved) {
  const fromUrl = parseProjectId(resolved.url);
  if (fromUrl) return fromUrl;
  if (resolved.html) {
    const strong =
      resolved.html.match(/(?:project_id|projectId)\s*["':=]+\s*"?(\d{5,})/i) ||
      resolved.html.match(/[?&](?:amp;)?(?:id|project_id)=(\d{5,})/i) ||
      resolved.html.match(/show\.bilibili\.com\/platform\/detail\.html\?id=(\d{5,})/i);
    if (strong) return strong[1];
  }
  return '';
}

/**
 * sale_flag.number 实测取值（扫描 80 个项目 / 300+ 票档）：
 *   1 = 未开售   （clickable=false）
 *   2 = 预售中   （clickable=true）  ← 唯一可下单状态
 *   3 = 已停售   （clickable=false）
 *   4 = 已售罄   （clickable=false, num=0）
 * 注意：is_sale 对所有状态恒为 1，不能用来判断是否在售。
 */
const FLAG = { PRESALE: 1, ON_SALE: 2, STOPPED: 3, SOLD_OUT: 4 };

const SOLD_OUT_WORDS = ['售罄', '售完', '缺货', '无票', '已抢光'];
const PRESALE_WORDS = ['未开售', '待开售', '即将开售', '未开始', '预售未开始'];
const STOPPED_WORDS = ['停售', '已结束', '下架', '不可售', '暂停销售', '已取消'];

/** 解析 "2026-11-13 19:00:00"（北京时间）或秒级时间戳 */
function parseSaleTime(v) {
  if (v === null || v === undefined || v === '') return 0;
  const str = String(v).trim();
  if (/^\d{9,}$/.test(str)) return Number(str);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m;
  return Math.floor(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(se || 0)) / 1000);
}

/** 票档状态归一化 */
function normalizeTicket(t) {
  const flagNumber = t.sale_flag && typeof t.sale_flag === 'object' ? t.sale_flag.number : null;
  const flagName =
    (t.sale_flag && typeof t.sale_flag === 'object' && t.sale_flag.display_name) ||
    (typeof t.sale_flag === 'string' ? t.sale_flag : '') ||
    '';
  const num = typeof t.num === 'number' ? t.num : null;
  // num 是「当前可购份数」，上限被每单限购数封顶，不是总库存
  const limit =
    t.static_limit && typeof t.static_limit.num === 'number' ? t.static_limit.num : null;
  const clickable = t.clickable === undefined ? null : !!t.clickable;

  // 以 sale_flag.number 白名单判定，文案只做兜底
  let status = 'unknown';
  if (flagNumber === FLAG.ON_SALE) status = 'available';
  else if (flagNumber === FLAG.SOLD_OUT) status = 'soldout';
  else if (flagNumber === FLAG.STOPPED) status = 'off';
  else if (flagNumber === FLAG.PRESALE) status = 'presale';
  else if (SOLD_OUT_WORDS.some((w) => flagName.includes(w))) status = 'soldout';
  else if (PRESALE_WORDS.some((w) => flagName.includes(w))) status = 'presale';
  else if (STOPPED_WORDS.some((w) => flagName.includes(w))) status = 'off';

  // 交叉校验：可购数量为 0 或按钮置灰时，绝不判为有票
  if (status === 'available' && (num === 0 || clickable === false)) status = 'unknown';

  return {
    id: String(t.id),
    desc: t.desc || t.name || '票档',
    price: typeof t.price === 'number' ? t.price : 0,
    num,
    limit,
    clickable,
    flagNumber,
    flagName,
    status,
    saleStart: t.sale_start || '',
    saleStartTs: parseSaleTime(t.sale_start),
  };
}

/**
 * 余票文案：num 被限购数封顶，等于上限时只能说明「有票」，不能说「剩 N 张」
 */
function stockText(ticket) {
  const { num, limit } = ticket;
  if (num === null || num === undefined) return '有票';
  if (num < 0) return '不限量';
  if (num === 0) return '售罄';
  if (limit && num < limit) return `仅剩 ${num} 张`;
  return '有票';
}

function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

function fmtTime(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth() + 1)}-${pad(utc8.getUTCDate())} ${pad(
    utc8.getUTCHours()
  )}:${pad(utc8.getUTCMinutes())}`;
}

/**
 * 拉取项目详情（含全部场次与票档）
 */
async function fetchProject(projectId, cookieStr) {
  const id = String(projectId);
  let ticket = '';
  try {
    const tk = await getBiliTicket(cookieStr);
    ticket = tk.ticket;
  } catch (e) {
    // 拿不到 ticket 也继续，接口本身不强制
    ticket = '';
  }

  const url = `https://show.bilibili.com/api/ticket/project/getV2?version=134&id=${encodeURIComponent(
    id
  )}&project_id=${encodeURIComponent(id)}&requestSource=pc-new`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `https://show.bilibili.com/platform/detail.html?id=${id}`,
      Origin: 'https://show.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      ...(ticket ? { Cookie: buildCookie(cookieStr, ticket) } : {}),
    },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });

  if (!res.ok) {
    const e = new Error(`接口 HTTP ${res.status}`);
    e.status = res.status;
    // 412 是 B 站网关级风控（request was banned），需要全局熔断而不是重试
    e.risk = res.status === 412;
    throw e;
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    const err = new Error('接口返回非 JSON（可能被风控拦截）');
    err.risk = true;
    throw err;
  }

  const code = json.code !== undefined ? json.code : json.errno;
  if (code !== 0 && code !== undefined) {
    const e = new Error(`接口返回 code=${code} ${json.message || json.msg || ''}`.trim());
    e.risk = code === -412 || /banned|风控|频繁/i.test(json.message || json.msg || '');
    throw e;
  }
  const d = json.data;
  if (!d) throw new Error('接口无 data 字段');

  const screens = (d.screen_list || []).map((s) => ({
    id: String(s.id),
    name: s.name || '场次',
    startTime: s.start_time || 0,
    startText: fmtTime(s.start_time),
    tickets: (s.ticket_list || []).map(normalizeTicket),
  }));

  return {
    id: String(d.id || id),
    name: d.name || `项目 ${id}`,
    saleStartTs: parseSaleTime(d.sale_start),
    cover: d.cover ? (d.cover.startsWith('//') ? `https:${d.cover}` : d.cover) : '',
    startTime: d.start_time || 0,
    startText: fmtTime(d.start_time),
    saleStart: d.sale_start || 0,
    saleStartText: fmtTime(d.sale_start),
    city: d.city || '',
    venue: d.venue_name || d.venue || '',
    // 接口服务器当前时间（秒），NTP 不可达时用于兜底校时
    serverNow: d.current_time ? Number(d.current_time) * 1000 : 0,
    screens,
    ticketMeta: { cached: !!ticket, hasTicket: !!ticket },
    fetchedAt: Date.now(),
  };
}

module.exports = {
  UA,
  FLAG,
  getBiliTicket,
  fetchProject,
  parseProjectId,
  isShortLink,
  resolveShortLink,
  extractProjectId,
  normalizeTicket,
  stockText,
  parseSaleTime,
  fmtTime,
  parseCookie,
  buildCookie,
};
