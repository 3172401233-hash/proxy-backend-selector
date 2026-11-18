export const HealthState = Object.freeze({
  HEALTHY: 'healthy',
  DRAINING: 'draining',
  UNHEALTHY: 'unhealthy',
  WARMING: 'warming',
});

/**
 * 单个后端实例的运行时状态。
 */
export class Endpoint {
  constructor({
    id,
    url = id,
    weight = 1,
    activeConnections = 0,
    inFlight = 0,
    healthy = true,
    ewmaLatency = null,
  }) {
    if (!id || typeof id !== 'string') {
      throw new Error('endpoint.id 必须是非空字符串');
    }
    this.id = id;
    this.url = url;
    this.weight = Math.max(0, weight);
    this.activeConnections = activeConnections;
    this.inFlight = inFlight;
    this.ewmaLatency = ewmaLatency;
    this.ramp = healthy ? 1 : 0;
    this.state = healthy ? HealthState.HEALTHY : HealthState.UNHEALTHY;
    this.reuseFailures = 0;
    this.penaltyUntil = 0;
  }

  /** ramp > 0 表示仍可接收新流量（摘除过程中逐步降到 0）。 */
  isEligible() {
    return this.ramp > 0;
  }
}
