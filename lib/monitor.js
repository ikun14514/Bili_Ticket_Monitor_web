'use strict';

const { fetchProject, stockText } = require('./bili');
const clock = require('./clock');

/** 高频轮询下，状态翻转需要连续命中几次才确认（防止接口抖动导致误报） */
const CONFIRM_FAST = 2;
const CONFIRM_SLOW = 1;
const FAST_INTERVAL_MS = 3000;

/** 只有「刚开售」才允许高频抢票；开售已久仍无票说明这一轮已卖完 */
const RUSH_WINDOW_MS = 10 * 60 * 1000;
/** 刷回流只在开票后这段时间内有意义（未支付订单释放高峰） */
const WATCH_WINDOW_MS = 30 * 60 * 1000;
/** 请求间隔安全下限：低于此值会直接撞 B 站 412 风控，实际执行时钳制 */
const MIN_RUSH_MS = 100;
const MIN_WATCH_MS = 200;
/** 412 熔断：首次冷却 30s，连续触发指数递增，最长 10 分钟 */
const RISK_BASE_MS = 30 * 1000;
const RISK_MAX_MS = 10 * 60 * 1000;
const RISK_RECOVER_MS = 60 * 1000;      // 熔断结束后的渐进恢复期
const RECOVER_MIN_MS = 1000;            // 恢复期内强制最小间隔
/** 阶段切换最小停留时间，避免 error ↔ soldout 抖动刷屏 */
const PHASE_MIN_HOLD_MS = 2000;
/**
 * 自适应节流（应对高峰期 412）：
 * 412 时把轮询间隔乘 2，连续 N 次请求正常再乘 0.75 回落，最小回到 1x。
 * 与「熔断」互补：熔断是零请求硬冷却，自适应是不中断监控的柔性降频。
 */
const ADAPT_MAX_MULT = 16;
const ADAPT_OK_TO_RECOVER = 12;
const ADAPT_UP = 2;
const ADAPT_DOWN = 0.75;
const ADAPT_CAP_MS = 30000;      // 自适应单次间隔上限，避免倍率叠加把监控拖死

function isRiskError(e) {
  return !!e && (e.risk === true || /412|banned|request was banned|风控/i.test(e.message || ''));
}

const STATUS_LABEL = {
  available: '有票',
  soldout: '售罄',
  presale: '未开售',
  off: '停售',
  unknown: '待检测',
  error: '异常',
};

const PHASE_LABEL = {
  blocked: '风控冷却',
  idle: '静默待开售',
  pending: '待开售',
  warmup: '预热',
  rush: '抢票',
  watch: '刷回流',
  steady: '观察',
  cooldown: '长尾',
  yield: '开售避让',
};

function nowTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? `0${n}` : n);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function formatSaleText(sec) {
  const d = new Date((Number(sec) + 8 * 3600) * 1000);
  const p = (n) => (n < 10 ? `0${n}` : n);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 单项目调度器
 * 待开售(低频确认) → 开售前预热 → 开售瞬间高频 → 售罄转刷回流 → 长尾观察
 */
class ProjectWorker {
  constructor(projectId, monitor) {
    this.pid = projectId;
    this.m = monitor;
    this.timer = null;
    this.active = false;
    this.phase = '';
    this.fail = 0;
    this.watchUntil = 0;
    this.nextAt = 0;
    this.interval = 0;
    this.actual = 0;
    this.lastStartAt = 0;
    this.requests = 0;
    this.lastError = '';
    this.soldoutSince = 0;   // 首次观测到全售罄的时刻
    this.phaseAt = 0;        // 上次阶段切换时刻（去抖）
  }

  start(delay = 300) {
    if (this.active) return;
    this.active = true;
    this.schedule(delay);
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = 0;
  }

  schedule(delay) {
    if (!this.active) return;
    // 幂等：任何重复排队都先撤销旧定时器，避免一次 run 排下两个 timer
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.run().catch((e) => {
        this.lastError = e.message;
        if (this.active) this.schedule(2000);
      });
    }, delay);
  }

  /**
   * 配置更新后重算调度：取消当前定时器，按新参数重新排队。
   * 静默期内只重排唤醒时间，绝不因为「保存设置」这个动作多发一次请求。
   */
  reschedule() {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watchUntil = 0;   // watchMinutes 改变后重新计时
    this.fail = 0;         // 丢掉旧的失败退避
    this.lastError = '';
    const targets = this.targets();
    const quiet = this.quietWait(clock.now(), targets);
    if (quiet > 0) {
      this.markQuiet(targets);
      // 保持阶段标签为「静默待开售」，否则要等下一次唤醒（最长 30 分钟）才纠正
      if (this.phase !== 'idle') {
        this.m.onPhaseChange(this, { phase: 'idle', interval: 0 }, targets);
        this.phase = 'idle';
      }
      this.interval = 0;
      this.actual = 0;
      this.schedule(quiet);
    } else {
      this.schedule(50);
    }
  }

  targets() {
    return this.m.store.targets.filter((t) => t.projectId === this.pid && t.enabled);
  }

  /** 本项目是否还有未来开售的场次（有则属于「即将开售」主角，不参与避让） */
  hasUpcomingSale(targets, now) {
    return targets.some((t) => (t.saleStart || 0) * 1000 > now);
  }

  /**
   * 静默期计算：距最近一场开售还很久时，完全不发请求
   * @returns {number} 需要静默等待的毫秒数，0 表示可以请求
   */
  quietWait(now, targets) {
    const s = this.m.store.settings;
    if (!s.quiet) return 0;
    // 首次（或服务刚重启）先真实请求一次，拿到权威状态再静默
    if (this.requests === 0) return 0;
    const warm = Math.max(5, s.warmupSeconds) * 1000;
    let next = 0;
    for (const t of targets) {
      const ts = (t.saleStart || 0) * 1000;
      if (!ts) return 0;      // 不知道开售时间，只能正常轮询
      if (ts <= now) return 0; // 已有票档进入开售，不能静默
      if (!next || ts < next) next = ts;
    }
    if (!next) return 0;
    const diff = next - now;
    if (diff <= warm) return 0;
    // 单次最多睡 30 分钟：醒来只重算时间，不发请求，顺带应对改期与系统时间跳变
    return Math.min(diff - warm + 50, 30 * 60 * 1000);
  }

  /** 静默期把「未检测」的目标标成未开售，避免大屏显示待检测 */
  markQuiet(targets) {
    let dirty = false;
    const now = Date.now();
    for (const t of targets) {
      const st = t.state || {};
      if (!st.checkedAt) {
        t.state = {
          status: 'presale',
          label: STATUS_LABEL.presale,
          num: 0,
          limit: 0,
          stock: '',
          available: false,
          checkedAt: now,
          changedAt: now,
          stale: false,
          pending: '',
          silent: true,
        };
        dirty = true;
      } else if (st.silent !== true) {
        // 静默期间不再请求，之前的失败/异常结论已过时，回到「未开售」
        t.state =
          st.status === 'error'
            ? {
                ...st,
                status: 'presale',
                label: STATUS_LABEL.presale,
                available: false,
                stale: false,
                silent: true,
                pending: '',
              }
            : { ...st, silent: true };
        dirty = true;
      }
    }
    if (dirty) this.m.store.saveSoon();
  }

  async run() {
    if (!this.active) return;
    const targets = this.targets();
    if (!targets.length) {
      this.stop();
      return;
    }

    // ---- 静默期：零请求，只等开售前 N 秒的唤醒 ----
    const quiet = this.quietWait(clock.now(), targets);
    if (quiet > 0) {
      this.markQuiet(targets);
      if (this.phase !== 'idle') {
        this.m.onPhaseChange(this, { phase: 'idle', interval: 0 }, targets);
        this.phase = 'idle';
      }
      this.interval = 0;
      this.actual = 0;
      this.lastError = '';
      this.m.onUpdate();
      this.schedule(quiet);
      return;
    }

    // ---- 风控熔断：出口 IP 被 B 站拉黑时，所有项目零请求等待解封 ----
    const riskLeft = this.m.riskWait(clock.now());
    if (riskLeft > 0) {
      this.fail = 0;
      if (this.phase !== 'blocked') {
        this.m.onPhaseChange(
          this,
          { phase: 'blocked', interval: 0, remaining: Math.ceil(riskLeft / 1000) },
          targets
        );
        this.phase = 'blocked';
        this.phaseAt = clock.now();
      }
      this.interval = 0;
      this.actual = 0;
      this.lastError = '';
      this.m.onUpdate();
      this.schedule(Math.min(riskLeft, 30000) + 50);
      return;
    }

    // ---- 开售避让：临近开售时暂停「刷回流 / 长尾」worker，给开抢让路 ----
    // 存在未来场次的项目自己是「即将开售」的主角，照常预热 / 抢票，不参与避让
    const avoid = this.m.saleAvoidance(clock.now());
    if (avoid && !this.hasUpcomingSale(targets, clock.now())) {
      this.fail = 0;
      this.lastError = '';
      if (this.phase !== 'yield') {
        this.m.onPhaseChange(
          this,
          { phase: 'yield', interval: 0, remaining: Math.ceil(avoid.remaining / 1000) },
          targets
        );
        this.phase = 'yield';
        this.phaseAt = clock.now();
      }
      this.interval = 0;
      this.actual = 0;
      this.m.onUpdate();
      // 睡到开售时刻（最多 30s 醒来重算一次），到点后自动恢复常规调度
      this.schedule(Math.min(avoid.remaining + 200, 30000) + 50);
      return;
    }

    const startedAt = Date.now();
    if (this.lastStartAt) this.actual = startedAt - this.lastStartAt;
    this.lastStartAt = startedAt;

    let project = null;
    let error = null;
    try {
      project = await fetchProject(this.pid, this.m.store.settings.cookie);
      this.fail = 0;
      this.lastError = '';
    } catch (e) {
      this.fail += 1;
      this.lastError = e.message;
      error = e;
      if (isRiskError(e)) {
        this.m.reportRisk(e, this);
        this.m.reportAdaptive(e, this);
      }
    }
    this.requests += 1;

    if (project) {
      if (project.serverNow) this.m._lastServerTime = project.serverNow;
      this.m.applyProject(project, targets, this);
      this.m.reportSuccess();
      this.m.reportAdaptiveSuccess();
    }
    else this.m.markProjectError(targets, error, this);

    // 本轮撞上 412（或全局熔断仍在生效）：立即切冷却，跳过常规阶段判定与高频调度
    const justRisk = this.m.riskWait(clock.now());
    if (justRisk > 0) {
      this.fail = 0;
      if (this.phase !== 'blocked') {
        this.m.onPhaseChange(
          this,
          { phase: 'blocked', interval: 0, remaining: Math.ceil(justRisk / 1000) },
          targets
        );
        this.phase = 'blocked';
        this.phaseAt = clock.now();
      }
      this.interval = 0;
      this.actual = 0;
      this.m.onUpdate();
      this.schedule(Math.min(justRisk, 30000) + 50);
      return;
    }

    let plan = this.decide(clock.now(), targets);
    // 熔断刚解除时强制降频，避免立刻回到 20ms 再次撞墙
    if (this.m.inRecovery(clock.now())) {
      plan = { ...plan, interval: Math.max(plan.interval, RECOVER_MIN_MS) };
    }

    const nowPhase = clock.now();
    if (plan.phase !== this.phase) {
      // 阶段短时来回跳动时抑制日志刷屏（阶段本身照常切换）
      const quietLog =
        nowPhase - this.phaseAt < PHASE_MIN_HOLD_MS &&
        plan.phase !== 'blocked' &&
        this.phase !== 'blocked';
      this.m.onPhaseChange(this, plan, targets, quietLog);
      this.phase = plan.phase;
      this.phaseAt = nowPhase;
    }

    let wait = plan.interval;
    if (this.fail > 0) {
      // 绝对时长退避：不能再乘 plan.interval（20ms 时 2^3 也只有 160ms，形同虚设）
      wait = Math.min(2000 * Math.pow(2, Math.min(this.fail - 1, 5)), 60000);
    } else if (plan.phase === 'pending' || plan.phase === 'steady' || plan.phase === 'cooldown') {
      wait = Math.round(wait * (0.85 + Math.random() * 0.3));
    }
    // 风控等级未清零时按等级拉长间隔（5s→10s→20s→…→60s），
    // 避免在 IP 仍被封的窗口里每 5 秒又试一次、反复触发 412
    if (this.m.risk.hits > 0) {
      wait = Math.max(wait, Math.min(5000 * Math.pow(2, this.m.risk.hits - 1), 60000));
    }
    // 自适应节流：412 高峰期按倍率平滑拉长间隔，监控不中断、不硬停
    const mult = this.m.adaptiveMult();
    if (mult > 1) {
      wait = Math.max(wait, Math.min(Math.round(wait * mult), ADAPT_CAP_MS));
    }
    this.interval = wait;
    // 减去本次请求耗时，让高频节奏贴近配置值
    const elapsed = Date.now() - startedAt;
    const delay = Math.max(20, wait - elapsed);
    this.m.onUpdate();
    this.schedule(delay);
  }

  decide(now, targets) {
    const s = this.m.store.settings;
    const states = targets.map((t) => t.state || {});
    const anyAvail = states.some((x) => x.status === 'available');
    const allSoldout = states.every((x) => x.status === 'soldout' || x.status === 'off');
    const anyBad = states.some((x) => x.status === 'error' || x.status === 'unknown' || x.stale);
    // 低于安全下限的配置不能真正按 20ms 发请求，否则必然触发 412
    const rushMs = Math.max(MIN_RUSH_MS, s.rushInterval);
    const watchMs = Math.max(MIN_WATCH_MS, s.watchInterval);

    let nextSale = 0;
    let lastSale = 0;
    for (const t of targets) {
      const ts = (t.saleStart || 0) * 1000;
      if (ts > now && (!nextSale || ts < nextSale)) nextSale = ts;
      if (ts && (!lastSale || ts > lastSale)) lastSale = ts;
    }

    // 还有未来场次 → 低频确认 / 预热（更早的阶段由 quietWait 静默接管）
    if (nextSale) {
      const diff = nextSale - now;
      if (diff > s.warmupSeconds * 1000) {
        return { phase: 'pending', interval: s.pendingInterval * 1000, diff };
      }
      if (diff > 5000) return { phase: 'warmup', interval: 1000, diff };
      return { phase: 'warmup', interval: 200, diff };
    }

    if (anyAvail) {
      this.watchUntil = 0;
      this.soldoutSince = 0;
      return { phase: 'steady', interval: s.steadyInterval };
    }

    // 「距最近一次开售过去多久」—— 开售已久却还无票，说明这一轮早卖完了
    const sinceSale = lastSale ? now - lastSale : Infinity;
    const openedRecently = sinceSale >= 0 && sinceSale <= RUSH_WINDOW_MS;

    // 请求失败 / 状态异常：绝不进高频。退避绝对时长由 run() 覆盖
    if (anyBad) return { phase: 'cooldown', interval: 5000 };

    if (allSoldout) {
      if (!this.soldoutSince) this.soldoutSince = now;
      // 只有「刚开售且刚转售罄」才值得 500ms 刷回流；开售 32 小时的项目不刷
      const inWatchWindow =
        sinceSale <= WATCH_WINDOW_MS && now - this.soldoutSince <= s.watchMinutes * 60000;
      if (inWatchWindow) {
        if (!this.watchUntil) this.watchUntil = now + s.watchMinutes * 60000;
        if (now < this.watchUntil) return { phase: 'watch', interval: watchMs };
      }
      this.watchUntil = 0;
      return { phase: 'cooldown', interval: 5000 };
    }

    // 只有开票后极短窗口内、状态仍未明确时才允许高频抢票
    if (openedRecently) return { phase: 'rush', interval: rushMs };

    // 开售已久 / 无开售时间 / 状态未知：一律低频长尾，绝不 fallback 到 rush
    return { phase: 'cooldown', interval: 5000 };
  }
}

class Monitor {
  constructor(store, hooks = {}) {
    this.store = store;
    this.onUpdate = hooks.onUpdate || (() => {});
    this.onLog = hooks.onLog || (() => {});
    this.workers = new Map();
    this.running = false;
    this._guard = null;
    this._lastRunAt = 0;
    this._lastError = '';
    this._numLogAt = new Map();
    this._recoverLogAt = 0;
    // 待确认的状态翻转：targetId -> { status, n }
    this._pending = new Map();
    this._syncAt = 0;         // 已做过开售前校时的开售时间
    this._syncing = false;
    this._lastServerTime = 0; // 接口返回的服务器时间，NTP 不通时兜底
    this._avoidLogAt = 0;     // 开售避让日志全局限流
    // B 站 412 风控是出口 IP 级的：一个项目被封，所有项目都要一起降频
    this.risk = { hits: 0, until: 0, recoverUntil: 0, lastAt: 0, lastLogAt: 0 };
    // 自适应节流状态：mult 为当前轮询间隔倍率（1x ~ 16x）
    this.adaptive = { mult: 1, ok: 0, hits: 0, lastAt: 0, lastLogAt: 0 };
  }

  avoidEnabled() {
    return this.store.settings.saleAvoid !== false;
  }

  avoidMinutes() {
    const n = Number(this.store.settings.avoidMinutes);
    return Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : 5;
  }

  /**
   * 开售避让窗口：全局扫描所有启用的目标，找出「即将开售」的最近一场。
   * 只要存在 saleStart 落在 (now, now + avoidMinutes] 的票档，就认为进入
   * 敏感窗口——此时刷回流/长尾类的高频请求最容易被 B 站判为异常、拉黑出口 IP。
   * @returns {{saleAt:number, remaining:number}|null}
   */
  saleAvoidance(now) {
    if (!this.avoidEnabled()) return null;
    const win = this.avoidMinutes() * 60000;
    let next = 0;
    for (const t of this.store.targets) {
      if (!t.enabled) continue;
      const ts = (t.saleStart || 0) * 1000;
      if (ts > now && ts <= now + win && (!next || ts < next)) next = ts;
    }
    if (!next) return null;
    return { saleAt: next, remaining: next - now };
  }

  adaptiveEnabled() {
    return this.store.settings.adaptivePacing !== false;
  }

  circuitEnabled() {
    return this.store.settings.riskCircuitBreaker !== false;
  }

  adaptiveMult() {
    return this.adaptiveEnabled() ? this.adaptive.mult : 1;
  }

  /**
   * 自适应节流：撞上 412 时把轮询间隔翻倍（上限 16x），不停止请求。
   * 高峰期 B 站会短暂拉黑出口 IP，硬熔断会漏掉解封瞬间的回流票，
   * 这里改为「持续请求但主动拉长间隔」，等风控自然解除。
   */
  reportAdaptive(err) {
    if (!this.adaptiveEnabled()) return;
    const a = this.adaptive;
    const now = clock.now();
    if (now - a.lastAt < 1000) return; // 同一轮并发 412 只调一档
    a.lastAt = now;
    a.ok = 0;
    a.hits += 1;
    const before = a.mult;
    a.mult = Math.min(ADAPT_MAX_MULT, a.mult * ADAPT_UP);
    if (now - a.lastLogAt > 15000) {
      a.lastLogAt = now;
      this.log(
        'warn',
        `【自适应节流】检测到 412（${err.message}）· 轮询间隔 ×${before} → ×${a.mult}` +
          `，持续请求但自动降频，连续 ${ADAPT_OK_TO_RECOVER} 次正常后回落`
      );
    }
    this.onUpdate();
  }

  /** 连续多次请求正常，倍率逐步回落到 1x */
  reportAdaptiveSuccess() {
    const a = this.adaptive;
    if (!this.adaptiveEnabled()) return;
    a.ok += 1;
    if (a.mult > 1 && a.ok >= ADAPT_OK_TO_RECOVER) {
      a.ok = 0;
      const before = a.mult;
      a.mult = Math.max(1, Math.round(a.mult * ADAPT_DOWN * 10) / 10);
      this.log('system', `【自适应节流】连续 ${ADAPT_OK_TO_RECOVER} 次请求正常 · 间隔倍率 ×${before} → ×${a.mult}`);
      this.onUpdate();
    }
  }

  /** 运行时切换 412 熔断开关；关闭时清掉已有冷却，交给自适应节流接管 */
  setCircuitBreaker(enabled) {
    const on = !!enabled;
    this.store.updateSettings({ riskCircuitBreaker: on });
    if (!on) {
      this.risk.hits = 0;
      this.risk.until = 0;
      this.risk.recoverUntil = 0;
    }
    this.reconfigure(['412 熔断']);
    this.log(
      'system',
      on
        ? '412 全局熔断已开启 · 命中风控时所有项目零请求冷却'
        : '412 全局熔断已关闭 · 由自适应节流接管降频（监控不中断）'
    );
    this.onUpdate();
  }

  /** 手动解除当前风控冷却并复位自适应倍率 */
  clearRisk() {
    this.risk.hits = 0;
    this.risk.until = 0;
    this.risk.recoverUntil = 0;
    this.adaptive.mult = 1;
    this.adaptive.ok = 0;
    this.adaptive.hits = 0;
    this.reconfigure(['风控状态']);
    this.log('system', '已手动解除风控冷却 · 自适应倍率复位为 ×1');
    this.onUpdate();
  }

  /** 412 熔断：全局零请求冷却，连续触发指数递增 */
  reportRisk(err) {
    const now = clock.now();
    // 熔断被用户关闭时：只记录、只调自适应倍率，绝不进入零请求冷却
    if (!this.circuitEnabled()) {
      if (now - this.risk.lastLogAt > 20000) {
        this.risk.lastLogAt = now;
        this.log(
          'warn',
          `【412】B 站返回 ${err.message} · 熔断已关闭，仅由自适应节流拉长间隔（监控不中断）`
        );
      }
      this.risk.lastAt = now;
      this.onUpdate();
      return;
    }
    // 多个 worker 并发报错时，同一轮只累加一次，避免冷却时间瞬间翻到上限
    if (now < this.risk.until && now - this.risk.lastAt < 3000) return;
    this.risk.hits = Math.min(this.risk.hits + 1, 8);
    this.risk.lastAt = now;
    const base = Math.min(RISK_BASE_MS * Math.pow(2, this.risk.hits - 1), RISK_MAX_MS);
    const cool = Math.round(base * (0.85 + Math.random() * 0.3));
    this.risk.until = now + cool;
    this.risk.recoverUntil = this.risk.until + RISK_RECOVER_MS;
    if (now - this.risk.lastLogAt > 20000) {
      this.risk.lastLogAt = now;
      const tip = this.store.settings.cookie
        ? ''
        : ' · 建议在设置里填入会员购 Cookie 降低风控概率';
      this.log(
        'warn',
        `【风控熔断】B 站返回 412（${err.message}）· 全部项目暂停请求 ${Math.round(cool / 1000)}s` +
          `，解封后自动降频恢复（第 ${this.risk.hits} 次）${tip}`
      );
    }
    this.onUpdate();
  }

  riskWait(now) {
    if (!this.circuitEnabled()) return 0;
    return now < this.risk.until ? this.risk.until - now : 0;
  }

  inRecovery(now) {
    return this.circuitEnabled() && now < this.risk.recoverUntil;
  }

  /** 完整熬过恢复期且期间不再 412，才认定风控解除、恢复正常节奏 */
  reportSuccess() {
    const r = this.risk;
    if (r.hits > 0 && clock.now() > r.recoverUntil) {
      r.hits = 0;
      r.recoverUntil = 0;
      this.log('system', '风控已解除 · 请求节奏恢复正常');
    }
  }

  get status() {
    const list = [...this.workers.values()].map((w) => ({
      projectId: w.pid,
      phase: w.phase || 'pending',
      label: PHASE_LABEL[w.phase] || '待开售',
      interval: w.interval,
      actual: w.actual || w.interval,
      requests: w.requests,
      nextAt: w.nextAt,
      error: w.lastError,
    }));
    const order = ['blocked', 'rush', 'warmup', 'watch', 'steady', 'pending', 'idle', 'yield', 'cooldown'];
    let dominant = '';
    for (const p of order) {
      if (list.some((w) => w.phase === p)) {
        dominant = p;
        break;
      }
    }
    const main = list.find((w) => w.phase === dominant);
    return {
      running: this.running,
      projects: list.length,
      phase: dominant || 'off',
      phaseLabel: PHASE_LABEL[dominant] || '待机',
      interval: main ? main.interval : 0,
      requests: list.reduce((a, w) => a + w.requests, 0),
      lastRunAt: this._lastRunAt,
      lastError: this._lastError,
      workers: list,
      risk: {
        enabled: this.circuitEnabled(),
        cooling: this.riskWait(clock.now()) > 0,
        remaining: Math.max(0, Math.ceil(this.riskWait(clock.now()) / 1000)),
        hits: this.risk.hits,
        recovering: this.inRecovery(clock.now()),
      },
      adaptive: {
        enabled: this.adaptiveEnabled(),
        multiplier: this.adaptiveMult(),
        hits: this.adaptive.hits,
        ok: this.adaptive.ok,
      },
      avoidance: (() => {
        const a = this.saleAvoidance(clock.now());
        return {
          enabled: this.avoidEnabled(),
          active: !!a,
          remaining: a ? Math.ceil(a.remaining / 1000) : 0,
          minutes: this.avoidMinutes(),
        };
      })(),
    };
  }

  log(level, text, extra = {}) {
    const entry = {
      id: `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      t: Date.now(),
      time: nowTime(),
      level,
      text,
      ...extra,
    };
    this.store.addLog(entry);
    this.onLog(entry);
    return entry;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.store.state.running = true;
    this.store.saveSoon();
    this.sync(true);
    this._guard = setInterval(() => {
      this.sync();
      this.checkClockSync();
    }, 1500);
    const s = this.store.settings;
    this.log(
      'system',
      `监控已启动 · 目标 ${this.enabledTargets().length} 个 · 开售 ${s.rushInterval}ms / 回流 ${s.watchInterval}ms / 待开售 ${s.pendingInterval}s`
    );
    // 启动先对一次表，避免本机时钟偏差影响倒计时
    this.syncClock('启动', true);
    this.onUpdate();
  }

  stop(silent = false) {
    if (!this.running) return;
    this.running = false;
    this.store.state.running = false;
    this.store.saveSoon();
    for (const w of this.workers.values()) w.stop();
    this.workers.clear();
    if (this._guard) clearInterval(this._guard);
    this._guard = null;
    if (!silent) this.log('system', '监控已暂停');
    this.onUpdate();
  }

  enabledTargets() {
    return this.store.targets.filter((t) => t.enabled);
  }

  /**
   * 配置变更后让所有在跑的 worker 立即按新参数重算。
   * 否则静默期最长 30 分钟的休眠会让改动迟迟不生效，看起来像「配置没保存」。
   */
  reconfigure(labels = []) {
    if (!this.running) return;
    this.sync();
    for (const w of this.workers.values()) w.reschedule();
    this.log(
      'system',
      labels.length
        ? `配置已生效（${labels.join('、')}）· 监控调度已按新参数重算`
        : '配置已生效 · 监控调度已重算'
    );
    this.onUpdate();
  }

  sync(immediate = false) {
    if (!this.running) return;
    const pids = new Set(this.enabledTargets().map((t) => t.projectId));
    for (const pid of pids) {
      if (!this.workers.has(pid)) {
        const w = new ProjectWorker(pid, this);
        this.workers.set(pid, w);
        w.start(immediate ? 200 : 500);
      }
    }
    for (const [pid, w] of this.workers) {
      if (!pids.has(pid)) {
        w.stop();
        this.workers.delete(pid);
      }
    }
  }

  /**
   * 开售前 60 秒校时（每个开售时间只做一次）
   * 用 1.5s 的守护定时器检查，触发精度 ±1.5s，不依赖轮询间隔
   */
  checkClockSync() {
    if (!this.running) return;
    const now = clock.now();
    let next = 0;
    for (const t of this.store.targets) {
      if (!t.enabled) continue;
      const ts = (t.saleStart || 0) * 1000;
      if (!ts || ts <= now) continue;
      if (!next || ts < next) next = ts;
    }
    if (!next) return;
    const diff = next - now;
    if (diff > 60000 || diff < 0) return;
    if (this._syncAt === next) return;
    this._syncAt = next;
    this.syncClock('开售前 60 秒');
  }

  async syncClock(reason, silent = false) {
    if (this._syncing) return null;
    this._syncing = true;
    try {
      const r = await clock.sync({ fallbackNow: this._lastServerTime });
      if (!silent) {
        const sign = r.offset >= 0 ? '+' : '';
        const degraded = r.source === 'bilibili' ? ' · NTP 不可达，已用接口时间兜底（±1s）' : '';
        this.log(
          'system',
          `NTP 校时（${reason}）· 偏差 ${sign}${r.offset}ms · RTT ${r.rtt}ms · ${r.host}${degraded}`
        );
      }
      this.onUpdate();
      return r;
    } catch (e) {
      if (!silent) this.log('warn', `NTP 校时失败（${reason}）：${e.message}`);
      return null;
    } finally {
      this._syncing = false;
    }
  }

  onPhaseChange(worker, plan, targets, silent = false) {
    this._lastRunAt = Date.now();
    const name = targets[0]?.alias || targets[0]?.projectName || `项目 ${worker.pid}`;
    const ms = plan.interval;
    let txt;
    if (plan.phase === 'blocked') {
      txt = `【风控冷却】「${name}」B 站返回 412 · 全部项目暂停请求 ${plan.remaining || 0}s，解封后自动降频恢复`;
    } else if (plan.phase === 'yield') {
      // 多个回流 worker 会同时进入避让，按全局限流只打一条，避免刷屏
      if (!silent && Date.now() - this._avoidLogAt > 20000) {
        this._avoidLogAt = Date.now();
        this.log(
          'system',
          `【开售避让】距开售约 ${plan.remaining || 0}s · 已暂停所有回流/长尾监控（零请求），给开抢让路防 IP 拉黑`
        );
      }
      return;
    } else if (plan.phase === 'idle') {
      let next = 0;
      for (const t of targets) {
        const ts = (t.saleStart || 0) * 1000;
        if (ts > Date.now() && (!next || ts < next)) next = ts;
      }
      const mins = next ? Math.max(1, Math.round((next - clock.now()) / 60000)) : 0;
      txt = `【静默】「${name}」距开售约 ${mins} 分钟 · 开售前 ${this.store.settings.warmupSeconds} 秒才开始请求（零请求防风控）`;
    } else if (plan.phase === 'rush') {
      txt = `【开售】「${name}」进入抢票模式 · ${ms}ms 轮询`;
    } else if (plan.phase === 'watch') {
      txt = `【售罄】「${name}」转入刷回流 · ${ms}ms 轮询（持续 ${this.store.settings.watchMinutes} 分钟）`;
    } else if (plan.phase === 'warmup') {
      txt = `【预热】「${name}」即将开售 · ${ms}ms 轮询`;
    } else if (plan.phase === 'cooldown') {
      txt = `【长尾】「${name}」回流高峰已过 · 转为 5s 低频观察`;
    } else if (plan.phase === 'steady') {
      txt = `【有票】「${name}」进入稳定观察 · ${Math.round(ms / 1000)}s 轮询`;
    } else {
      txt = `「${name}」待开售 · ${Math.round(ms / 1000)}s 确认一次`;
    }
    if (silent) return;
    this.log(plan.phase === 'rush' ? 'alert' : plan.phase === 'blocked' ? 'warn' : 'system', txt);
  }

  markProjectError(targets, err, worker) {
    const n = worker ? worker.fail : 1;
    const name = targets[0]?.projectName || (worker && worker.pid) || '';
    if (n === 1 || n % 10 === 0) {
      this.log('error', `「${name}」请求失败(${n})：${err.message}`);
    }
    const now = Date.now();
    for (const t of targets) {
      const prev = t.state || {};
      // 偶发失败不清空已有结论，只打 stale 标记；连续多次失败才降级为异常
      if (n < 5 && prev.status && prev.status !== 'error') {
        t.state = { ...prev, stale: true, checkedAt: now };
      } else {
        t.state = { ...prev, status: 'error', available: false, stale: true, checkedAt: now };
      }
    }
  }

  /**
   * 把一次接口结果落到目标上
   * @param {object|null} worker 调用方 worker，用于按当前轮询节奏决定去抖次数
   */
  applyProject(project, targets, worker = null) {
    const index = new Map();
    for (const s of project.screens) {
      for (const tk of s.tickets) index.set(tk.id, { ticket: tk, screen: s });
    }
    const needConfirm =
      worker && worker.interval && worker.interval <= FAST_INTERVAL_MS ? CONFIRM_FAST : CONFIRM_SLOW;

    let dirty = false;
    let recovered = 0;
    for (const t of targets) {
      const hit = index.get(t.ticketId);
      if (!hit) {
        this._pending.delete(t.id);
        t.state = {
          ...(t.state || {}),
          status: 'off',
          available: false,
          checkedAt: Date.now(),
          flagName: '票档已下架',
        };
        dirty = true;
        continue;
      }
      const tk = hit.ticket;
      const prev = t.state || {};
      const isFirst = !prev.checkedAt;

      t.projectName = project.name;
      t.screenName = hit.screen.name;
      t.screenStart = hit.screen.startText;
      t.ticketName = tk.desc;
      t.price = tk.price;

      const saleStart = tk.saleStartTs || project.saleStartTs || 0;
      if (saleStart) {
        const saleText = formatSaleText(saleStart);
        if (saleStart !== t.saleStart || saleText !== t.saleStartText) {
          t.saleStart = saleStart;
          t.saleStartText = saleText;
          dirty = true;
        }
      }

      // ---- 状态翻转去抖：连续 N 次观测到同一新状态才采信 ----
      let observed = tk.status;
      if (!isFirst && observed !== prev.status) {
        const p = this._pending.get(t.id);
        const n = p && p.status === observed ? p.n + 1 : 1;
        this._pending.set(t.id, { status: observed, n });
        if (n < needConfirm) {
          // 未达确认次数：保留原结论，只标记「确认中」
          t.state = {
            ...prev,
            checkedAt: Date.now(),
            pending: observed,
            pendingN: n,
            stale: false,
            rawNum: tk.num,
            rawFlag: tk.flagName,
          };
          continue;
        }
        this._pending.delete(t.id);
      } else {
        this._pending.delete(t.id);
        observed = isFirst ? observed : prev.status;
      }

      const nextAvailable = observed === 'available';
      const prevAvailable = !!prev.available;
      const changed = isFirst || nextAvailable !== prevAvailable;

      t.state = {
        status: observed,
        label: STATUS_LABEL[observed] || observed,
        num: tk.num,
        limit: tk.limit,
        stock: nextAvailable ? stockText(tk) : '',
        flagName: tk.flagName,
        flagNumber: tk.flagNumber,
        clickable: tk.clickable,
        available: nextAvailable,
        checkedAt: Date.now(),
        changedAt: changed ? Date.now() : prev.changedAt || Date.now(),
        price: tk.price,
        stale: false,
        pending: '',
      };

      const title = this.displayName(t);
      const numText = stockText(tk);
      const sub = t.screenName || '';

      if (isFirst) {
        if (nextAvailable) {
          this.log('info', `开始监控「${title}」｜ ${sub} ｜ 当前${numText}`, { targetId: t.id });
        } else {
          this.log('system', `开始监控「${title}」｜ ${sub} ｜ 当前${STATUS_LABEL[observed] || observed}`);
        }
        dirty = true;
      } else if (!prevAvailable && nextAvailable) {
        this.log('alert', `【有票】${title} ｜ ${sub} ｜ ${numText}`, { targetId: t.id, num: tk.num });
        dirty = true;
      } else if (prevAvailable && !nextAvailable) {
        this.log('warn', `【${STATUS_LABEL[observed] || observed}】${title} ｜ ${sub}`, { targetId: t.id });
        dirty = true;
      } else if (nextAvailable && prev.num !== tk.num) {
        // 高频轮询下余票数量频繁变动，日志按目标限流 60 秒一条
        const lastAt = this._numLogAt.get(t.id) || 0;
        if (Date.now() - lastAt > 60000) {
          this._numLogAt.set(t.id, Date.now());
          this.log('info', `${title} ｜ ${sub} 余票更新：${numText}`, { targetId: t.id });
        }
        dirty = true;
      } else if (prev.status !== observed) {
        // 从「异常 / 请求失败」恢复属于正常回落，逐票档打 warn 会在风控期刷满日志
        if (prev.status === 'error' || prev.stale) recovered += 1;
        else this.log('warn', `【${STATUS_LABEL[observed] || observed}】${title} ｜ ${sub}`, { targetId: t.id });
        dirty = true;
      }
    }
    if (recovered && Date.now() - this._recoverLogAt > 30000) {
      this._recoverLogAt = Date.now();
      this.log('system', `接口恢复 · ${recovered} 个票档状态已重新确认`);
    }
    if (dirty) this.store.saveSoon();
  }

  displayName(t) {
    return t.alias || t.projectName || `项目 ${t.projectId}`;
  }

  async checkTarget(id) {
    const t = this.store.getTarget(id);
    if (!t) return { ok: false, error: '目标不存在' };
    try {
      const project = await fetchProject(t.projectId, this.store.settings.cookie);
      this.applyProject(project, [t]);
      this.onUpdate();
      return { ok: true, state: t.state };
    } catch (e) {
      this.markProjectError([t], e, null);
      this.onUpdate();
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { Monitor, STATUS_LABEL, PHASE_LABEL };
