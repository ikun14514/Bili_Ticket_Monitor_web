'use strict';

/**
 * 时钟校准（SNTP）
 *
 * 目的：大屏倒计时和「开售瞬间切高频」都依赖本机时钟。主播机器常年不校准，
 * 偏差几百毫秒到几秒都常见，开票前必须对齐真实时间。
 *
 * 实现：纯 Node dgram 发 SNTP 包（UDP 123），多服务器并发取样，取 RTT 最小的一台：
 *   offset = ((T2 - T1) + (T3 - T4)) / 2
 *   T1 本机发送 / T2 服务器收到 / T3 服务器发出 / T4 本机收到
 * 失败时可用外部传入的服务器时间兜底（粒度 1 秒）。
 */

const dgram = require('dgram');

const NTP_EPOCH_DELTA = 2208988800; // 1900-01-01 → 1970-01-01 的秒数
const HOSTS = ['ntp.aliyun.com', 'ntp.tencent.com', 'cn.pool.ntp.org', 'time.cloudflare.com'];
const MAX_OFFSET = 5000; // 超过 5 秒的“校正”视为异常，拒绝采信

const state = {
  offset: 0, // 本机时间 + offset = 真实时间（毫秒）
  rtt: 0,
  host: '',
  source: '', // ntp | bilibili | manual
  syncedAt: 0,
  error: '',
  syncing: false,
};

function now() {
  return Date.now() + state.offset;
}

function ntpToMs(buf, offset) {
  const sec = buf.readUInt32BE(offset);
  const frac = buf.readUInt32BE(offset + 4);
  return (sec - NTP_EPOCH_DELTA) * 1000 + (frac / 4294967296) * 1000;
}

/** 单台服务器取样 */
function query(host, timeout = 2200) {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch (e) {
      return resolve({ host, error: e.message });
    }
    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // LI=0, VN=4, Mode=3(client)
    const t1 = Date.now();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch (e) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ host, error: '超时' }), timeout);

    sock.on('message', (msg) => {
      const t4 = Date.now();
      if (msg.length < 48) return finish({ host, error: '响应过短' });
      const mode = msg[0] & 0x07;
      const stratum = msg[1];
      if (mode !== 4 || stratum === 0) return finish({ host, error: '响应无效' });
      const t2 = ntpToMs(msg, 32); // 服务器收到
      const t3 = ntpToMs(msg, 40); // 服务器发出
      const offset = (t2 - t1 + (t3 - t4)) / 2;
      const rtt = t4 - t1 - (t3 - t2);
      finish({ host, offset, rtt: Math.max(0, rtt) });
    });
    sock.on('error', (e) => finish({ host, error: e.message }));
    sock.send(packet, 123, host, (err) => {
      if (err) finish({ host, error: err.message });
    });
  });
}

function status() {
  return {
    offset: Math.round(state.offset),
    rtt: Math.round(state.rtt),
    host: state.host,
    source: state.source,
    syncedAt: state.syncedAt,
    // 相对校准时刻又过去了多久（用于判断新鲜度）
    age: state.syncedAt ? Date.now() - state.syncedAt : 0,
    error: state.error,
    syncing: state.syncing,
  };
}

function apply(offset, rtt, host, source) {
  state.offset = offset;
  state.rtt = rtt;
  state.host = host;
  state.source = source;
  state.syncedAt = Date.now();
  state.error = '';
}

/**
 * 向 NTP 校时
 * @param {{hosts?:string[], timeout?:number, fallbackNow?:number}} opts
 */
async function sync(opts = {}) {
  if (state.syncing) return { ...status(), skipped: true };
  state.syncing = true;
  let out = null;
  try {
    const hosts = (opts.hosts && opts.hosts.length ? opts.hosts : HOSTS).slice(0, 4);
    const results = await Promise.all(hosts.map((h) => query(h, opts.timeout || 2200)));
    const valid = results.filter((r) => !r.error && Math.abs(r.offset) < MAX_OFFSET);
    if (!valid.length) {
      const detail = results.map((r) => `${r.host} ${r.error || '偏差异常'}`).join('，');
      throw new Error(`NTP 校时失败：${detail}`);
    }
    valid.sort((a, b) => a.rtt - b.rtt || Math.abs(a.offset) - Math.abs(b.offset));
    const best = valid[0];
    apply(best.offset, best.rtt, best.host, 'ntp');
    out = { ...status(), samples: valid.length };
  } catch (e) {
    state.error = e.message;
    // 兜底：用接口返回的服务器时间（精度 1 秒）
    if (opts.fallbackNow) {
      const offset = Number(opts.fallbackNow) - Date.now();
      if (Math.abs(offset) < MAX_OFFSET) {
        apply(offset, 0, 'bilibili 接口时间', 'bilibili');
        out = { ...status(), degraded: true };
      }
    }
    throw e;
  } finally {
    state.syncing = false;
  }
  return { ...out, syncing: false };
}

/** 使用外部时间源兜底（不抛错） */
function applyFallback(serverMs, source = 'bilibili') {
  const offset = Number(serverMs) - Date.now();
  if (!Number.isFinite(offset) || Math.abs(offset) >= MAX_OFFSET) return false;
  apply(offset, 0, source === 'bilibili' ? 'bilibili 接口时间' : source, source);
  return true;
}

module.exports = { now, sync, status, applyFallback, HOSTS };
