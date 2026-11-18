# proxy-backend-selector

JavaScript 代理后端选择库，处理负载权重、连接复用、故障隔离和会话亲和。

传统 `least-connections` 只看当前连接数：慢后端上的请求迟迟不结束，却因为连接数
不高而持续接到新流量；打开会话亲和后，固定哈希又会让部分实例几乎收不到流量。
本库在 least-connections 基础上同时计入 **在途请求、连接建立/复用成本（EWMA
延迟）、健康 ramp 和复用失败惩罚**，会话亲和使用 HRW 并带过载熔断。

## 负载计算公式

每个可接收流量的实例（`ramp > 0`）按以下公式评分，**分数越低越优先**：

```
load           = 1 + inFlight + connectionWeight * activeConnections
latencyFactor  = ewmaLatency == null ? 1 : (1 + ewmaLatency / 1000)
capacity       = weight * ramp
baseScore      = load * latencyFactor / capacity
score          = baseScore * penaltyFactor * jitter
```

- `inFlight`：在途请求数（已接收、未完成），慢后端会在此自然累积，直接抑制新流量。
- `activeConnections`：当前连接数（含空闲 keep-alive），以 `connectionWeight`
  （默认 `0.2`）折算，避免空闲连接与真正在处理的请求等权。
- 常数 `1` 保证空实例也有正负载，空实例永远比忙碌实例优先，且同权空实例轮询均分。
- `ewmaLatency`：最近延迟的指数移动平均（EWMA，`α = ewmaAlpha`，默认 `0.35`），
  延迟越高 `latencyFactor` 越大，连接建立慢的实例被降权；无样本时为 `1`。
- `weight`：配置权重；`ramp`：健康 ramp（见下），两者乘积才是实际容量。
- `penaltyFactor`：连接复用失败惩罚期内为 `1 + reuseFailures`，否则为 `1`。
- `jitter`：`1 ± jitterPct`（默认 3%）的确定性抖动，仅用于打破完全平局；
  随机序列由构造参数 `seed` 的 mulberry32 PRNG 生成，**相同状态与种子得到
  完全相同的选择序列与分布**。

### 平滑摘除与渐进加回

`recordHealthCheck(id, healthy)` 驱动四态状态机，流量通过 `ramp` 平滑过渡，
而非一次性硬摘：

```
healthy(ramp=1) --失败--> draining(0.5) --失败--> unhealthy(0，停止新流量)
unhealthy       --成功--> warming(0.25 -> 0.5 -> 0.75 -> 1) --> healthy
```

`draining` 期间实例仍按半容量服务存量流量，`warming` 期间每次健康检查成功
增加 `warmStep`（默认 0.25）容量，恢复后自动回到全量。

### 会话亲和

- 带 `sessionKey` 选择时，用 Rendezvous Hashing（HRW，FNV-1a + murmur3
  finalizer）在候选实例中确定性映射，同一 key 始终落到同一实例，成员变化时
  映射迁移面最小。
- 过载熔断：若粘性实例的 `baseScore` 超过当前最低分的 `stickyMaxLoadRatio`
  倍（默认 1.75），放弃粘性改选最低分实例，避免固定哈希造成实例饿死。
- `nextAlternative(previousId, sessionKey)` 排除刚失败的实例并返回下一候选，
  可直接用于重试链；key 存在时重试目标同样确定。

### 连接复用失败

keep-alive 套接字被对端关闭等复用失败时调用 `recordReuseFailure(id)`：
失败计数 +1 并施加指数退避惩罚（初始 500ms，上限 8s），惩罚期内评分乘
`1 + reuseFailures`；`recordReuseSuccess(id)` 清除计数与惩罚。

## 用法

```js
import { BackendSelector } from './index.js';

const selector = new BackendSelector([
  { id: 'ep-a', url: 'http://10.0.0.1:8080', weight: 2 },
  { id: 'ep-b', url: 'http://10.0.0.2:8080', weight: 1 },
  { id: 'ep-c', url: 'http://10.0.0.3:8080', weight: 1 },
], { seed: 42 });

const id = selector.selectAndBegin(req.sessionId); // 选择并在途 +1
try {
  // ... 转发请求，记录耗时
  selector.reportLatency(id, latencyMs);
} catch (err) {
  const retryId = selector.nextAlternative(id, req.sessionId); // 重试备选
} finally {
  selector.endRequest(id); // 在途 -1
}

selector.recordHealthCheck('ep-b', false); // 健康检查事件（平滑摘除/加回）
selector.recordReuseFailure('ep-c');       // 连接复用失败
selector.updateMetrics('ep-a', { activeConnections: 12 }); // 外部观测指标
```

## API

- `new BackendSelector(endpoints, options?)`
- `select(sessionKey?)` / `selectAndBegin(sessionKey?)`：选择目标（后者同时在途 +1）
- `nextAlternative(previousId, sessionKey?)`：排除指定实例的重试备选
- `beginRequest(id)` / `endRequest(id, latencyMs?)` / `reportLatency(id, ms)`
- `updateMetrics(id, { activeConnections, inFlight, ewmaLatency })`
- `recordHealthCheck(id, healthy)` / `setWeight(id, weight)`
- `recordReuseFailure(id)` / `recordReuseSuccess(id)`
- `explain(id)` / `lastRanking`：评分明细与最近排序，便于观测调试

无健康实例（全部 `ramp = 0`）时 `select` 返回 `null`。

## 测试

```bash
node --test
```

覆盖：突发流量均匀性、慢后端（高 EWMA 延迟）降权、连接复用失败惩罚与恢复、
会话亲和/过载熔断/确定性重试、权重变化、健康平滑摘除与渐进加回、同种子
选择序列的确定性。
