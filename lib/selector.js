import { mulberry32 } from './prng.js';
import { fnv1a32 } from './hash.js';
import { Endpoint, HealthState } from './endpoint.js';

const DEFAULTS = Object.freeze({
  seed: 0x2f6e2b1,
  // EWMA 延迟平滑系数：新样本权重
  ewmaAlpha: 0.35,
  // 健康检查首次失败后保留的流量比例（平滑摘除第一步）
  drainFactor: 0.5,
  // 恢复预热时每次成功检查增加的流量比例
  warmStep: 0.25,
  // 会话亲和实例负载超过最低负载的倍数时放弃粘性，避免实例饿死其他节点
  stickyMaxLoadRatio: 1.75,
  // 同分抖动幅度，仅用于打破完全平局；种子相同则抖动序列相同
  jitterPct: 0.03,
  // 首次连接复用失败的惩罚时长
  reuseFailPenaltyMs: 500,
  // 复用失败惩罚上限
  reuseFailMaxPenaltyMs: 8000,
  // 当前连接（含空闲 keep-alive）相对在途请求的负载权重
  connectionWeight: 0.2,
});

/**
 * 后端选择器：在 least-connections 基础上引入在途请求、EWMA 延迟、
 * 权重、健康 ramp、复用失败惩罚和会话亲和（HRW + 过载熔断）。
 */
export class BackendSelector {
  constructor(endpoints = [], options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = typeof this.options.now === 'function' ? this.options.now : () => Date.now();
    this._rand = mulberry32(this.options.seed >>> 0);
    this.endpoints = new Map();
    this._lastRank = [];
    for (const config of endpoints) {
      this.addEndpoint(config);
    }
  }

  addEndpoint(config) {
    const endpoint = config instanceof Endpoint ? config : new Endpoint(config);
    if (this.endpoints.has(endpoint.id)) {
      throw new Error(`重复的 endpoint id: ${endpoint.id}`);
    }
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  getEndpoint(id) {
    return this.endpoints.get(id);
  }

  setWeight(id, weight) {
    const endpoint = this._require(id);
    endpoint.weight = Math.max(0, weight);
    return endpoint;
  }

  /** 批量更新连接数 / 在途请求等外部观测指标。 */
  updateMetrics(id, patch = {}) {
    const endpoint = this._require(id);
    if (patch.activeConnections != null) {
      endpoint.activeConnections = Math.max(0, patch.activeConnections);
    }
    if (patch.inFlight != null) {
      endpoint.inFlight = Math.max(0, patch.inFlight);
    }
    if (patch.ewmaLatency != null) {
      endpoint.ewmaLatency = patch.ewmaLatency;
    }
    return endpoint;
  }

  /** 请求开始：在途请求 +1。 */
  beginRequest(id) {
    const endpoint = this._require(id);
    endpoint.inFlight += 1;
    return id;
  }

  /** 请求结束：在途请求 -1，并用本次耗时更新 EWMA 延迟。 */
  endRequest(id, latencyMs) {
    const endpoint = this._require(id);
    endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
    if (latencyMs != null) {
      this.reportLatency(id, latencyMs);
    }
    return endpoint;
  }

  reportLatency(id, latencyMs) {
    const endpoint = this._require(id);
    if (typeof latencyMs !== 'number' || Number.isNaN(latencyMs) || latencyMs < 0) {
      throw new Error('latencyMs 必须是非负数字');
    }
    const alpha = this.options.ewmaAlpha;
    endpoint.ewmaLatency = endpoint.ewmaLatency == null
      ? latencyMs
      : alpha * latencyMs + (1 - alpha) * endpoint.ewmaLatency;
    return endpoint;
  }

  /**
   * 连接复用失败（例如 keep-alive 套接字已被对端关闭）：
   * 计数 +1，施加指数退避的分数惩罚，期间仍可被选中但优先级降低。
   */
  recordReuseFailure(id, now = this.now()) {
    const endpoint = this._require(id);
    endpoint.reuseFailures += 1;
    const base = this.options.reuseFailPenaltyMs;
    const backoff = base * 2 ** (endpoint.reuseFailures - 1);
    endpoint.penaltyUntil = now + Math.min(backoff, this.options.reuseFailMaxPenaltyMs);
    return endpoint;
  }

  /** 复用成功后清除惩罚计数。 */
  recordReuseSuccess(id) {
    const endpoint = this._require(id);
    endpoint.reuseFailures = 0;
    endpoint.penaltyUntil = 0;
    return endpoint;
  }

  /**
   * 健康检查事件，驱动平滑摘除 / 渐进加回状态机：
   * healthy -> 失败 -> draining(ramp=0.5) -> 再失败 -> unhealthy(ramp=0)
   * unhealthy -> 成功 -> warming(0.25 -> 0.5 -> 0.75 -> 1) -> healthy
   */
  recordHealthCheck(id, healthy, now = this.now()) {
    const endpoint = this._require(id);
    void now;
    if (healthy) {
      if (endpoint.state === HealthState.HEALTHY && endpoint.ramp === 1) {
        return endpoint;
      }
      if (endpoint.state === HealthState.WARMING) {
        endpoint.ramp = Math.min(1, endpoint.ramp + this.options.warmStep);
        if (endpoint.ramp >= 1) {
          endpoint.state = HealthState.HEALTHY;
        }
      } else {
        endpoint.state = HealthState.WARMING;
        endpoint.ramp = this.options.warmStep;
      }
    } else if (endpoint.state !== HealthState.UNHEALTHY) {
      if (endpoint.state === HealthState.WARMING || endpoint.ramp <= this.options.drainFactor) {
        endpoint.ramp = 0;
        endpoint.state = HealthState.UNHEALTHY;
      } else {
        endpoint.state = HealthState.DRAINING;
        endpoint.ramp = this.options.drainFactor;
      }
    }
    return endpoint;
  }

  /**
   * 选择一个后端。sessionKey 非空时启用会话亲和：
   * 优先返回 HRW 映射的实例，仅当其负载超过最低负载的 stickyMaxLoadRatio 倍
   * 时才熔断粘性，避免会话分布不均造成实例饿死。
   * 无可用实例时返回 null。
   */
  select(sessionKey = null) {
    const ranked = this._rank(this.now());
    if (ranked.length === 0) {
      return null;
    }
    if (sessionKey != null) {
      const sticky = this._stickyRow(sessionKey, ranked);
      if (sticky) {
        return sticky.ep.id;
      }
    }
    return ranked[0].ep.id;
  }

  /** 选择重试备选：排除上一个失败实例，会话 key 存在时按 HRW 确定性切换。 */
  nextAlternative(previousId, sessionKey = null) {
    const ranked = this._rank(this.now()).filter((row) => row.ep.id !== previousId);
    if (ranked.length === 0) {
      return null;
    }
    if (sessionKey != null) {
      const sticky = this._stickyRow(sessionKey, ranked);
      if (sticky) {
        return sticky.ep.id;
      }
    }
    return ranked[0].ep.id;
  }

  /** 选择并立即记账（在途请求 +1），无可用实例时返回 null。 */
  selectAndBegin(sessionKey = null) {
    const id = this.select(sessionKey);
    if (id == null) {
      return null;
    }
    this.beginRequest(id);
    return id;
  }

  /** 返回某实例当前的评分明细，便于观测与调试。 */
  explain(id) {
    const endpoint = this._require(id);
    const { base, score } = this._score(endpoint, this.now());
    return {
      id: endpoint.id,
      state: endpoint.state,
      ramp: endpoint.ramp,
      weight: endpoint.weight,
      inFlight: endpoint.inFlight,
      activeConnections: endpoint.activeConnections,
      ewmaLatency: endpoint.ewmaLatency,
      baseScore: base,
      jitteredScore: score,
      penalized: endpoint.penaltyUntil > this.now(),
    };
  }

  /** 最近一次评分排序（调试用）。 */
  get lastRanking() {
    return this._lastRank.map((row) => ({
      id: row.ep.id,
      baseScore: row.base,
      score: row.score,
    }));
  }

  _stickyRow(sessionKey, ranked) {
    const mapped = this._hrw(sessionKey, ranked.map((row) => row.ep));
    const row = ranked.find((candidate) => candidate.ep.id === mapped.id);
    const minBase = ranked[0].base;
    if (row.base <= minBase * this.options.stickyMaxLoadRatio) {
      return row;
    }
    return null;
  }

  /** Rendezvous Hashing：对每个候选计算 (key, id) 哈希，取最大者。 */
  _hrw(sessionKey, candidates) {
    let best = null;
    let bestHash = -1;
    for (const endpoint of candidates) {
      const hash = fnv1a32(`${sessionKey}#${endpoint.id}`);
      if (hash > bestHash) {
        bestHash = hash;
        best = endpoint;
      }
    }
    return best;
  }

  _rank(now) {
    const ranked = [...this.endpoints.values()]
      .filter((endpoint) => endpoint.isEligible())
      .map((endpoint) => {
        const { base, score } = this._score(endpoint, now);
        return { ep: endpoint, base, score };
      })
      .sort((a, b) => (a.score - b.score) || a.ep.id.localeCompare(b.ep.id));
    this._lastRank = ranked;
    return ranked;
  }

  /**
   * 负载评分：
   *   load = 1 + inFlight + connectionWeight * activeConnections
   *   latencyFactor = 1 + ewmaLatency / 1000
   *   capacity = weight * ramp
   *   baseScore = load * latencyFactor / capacity
   * 复用失败惩罚期内再乘以 (1 + reuseFailures)，最后施加种子确定性抖动。
   */
  _score(endpoint, now) {
    const { connectionWeight, jitterPct } = this.options;
    const load = 1 + endpoint.inFlight + connectionWeight * endpoint.activeConnections;
    const latencyFactor = endpoint.ewmaLatency == null
      ? 1
      : 1 + endpoint.ewmaLatency / 1000;
    const capacity = Math.max(endpoint.weight * endpoint.ramp, 1e-9);
    let base = (load * latencyFactor) / capacity;
    if (endpoint.penaltyUntil > now) {
      base *= 1 + endpoint.reuseFailures;
    }
    const jitter = 1 + (this._rand() * 2 - 1) * jitterPct;
    return { base, score: base * jitter };
  }

  _require(id) {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) {
      throw new Error(`未知的 endpoint id: ${id}`);
    }
    return endpoint;
  }
}
