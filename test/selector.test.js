import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendSelector, HealthState } from '../index.js';

function makeSelector(count = 3, options = {}) {
  const endpoints = Array.from({ length: count }, (_, index) => ({
    id: `ep-${String.fromCharCode(97 + index)}`,
    weight: 1,
  }));
  return new BackendSelector(endpoints, { seed: 42, ...options });
}

function tally(picks) {
  const counts = new Map();
  for (const id of picks) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

test('突发流量：在途请求感知，负载在同权实例间均匀分布', () => {
  const selector = makeSelector(3);
  const picks = [];

  for (let step = 0; step < 300; step += 1) {
    for (let k = 0; k < 3; k += 1) {
      const id = selector.selectAndBegin();
      assert.ok(id, '健康实例存在时必须选出目标');
      picks.push(id);
    }
    for (const endpoint of selector.endpoints.values()) {
      endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
    }
  }

  const counts = tally(picks);
  for (const id of selector.endpoints.keys()) {
    const share = counts.get(id) / picks.length;
    assert.ok(Math.abs(share - 1 / 3) < 0.05, `${id} 流量占比 ${share} 偏离均匀分布`);
  }
});

test('确定性：相同状态与随机种子产生完全相同的选择序列', () => {
  const build = () => makeSelector(3);
  const a = build();
  const b = build();
  const seqA = [];
  const seqB = [];

  for (let step = 0; step < 100; step += 1) {
    seqA.push(a.selectAndBegin());
    seqB.push(b.selectAndBegin());
    for (const endpoint of a.endpoints.values()) {
      endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
    }
    for (const endpoint of b.endpoints.values()) {
      endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
    }
  }
  assert.deepEqual(seqA, seqB);

  const different = makeSelector(3, { seed: 99999 });
  const seqC = [];
  for (let step = 0; step < 100; step += 1) {
    seqC.push(different.selectAndBegin());
    for (const endpoint of different.endpoints.values()) {
      endpoint.inFlight = Math.max(0, endpoint.inFlight - 1);
    }
  }
  assert.notDeepEqual(seqC, seqA, '不同种子应产生不同的平局打破序列');
});

test('慢后端：高 EWMA 延迟的实例在其他实例有余量时被少选', () => {
  const selector = makeSelector(3);
  const [slow, fast1, fast2] = [...selector.endpoints.keys()];
  selector.reportLatency(slow, 800);
  selector.reportLatency(fast1, 40);
  selector.reportLatency(fast2, 40);

  const picks = [];
  for (let step = 0; step < 600; step += 1) {
    for (let k = 0; k < 4; k += 1) {
      picks.push(selector.selectAndBegin());
    }
    for (const endpoint of selector.endpoints.values()) {
      const probability = endpoint.id === slow ? 0.25 : 0.6;
      endpoint.inFlight = Math.max(
        0,
        endpoint.inFlight - Math.ceil(endpoint.inFlight * probability),
      );
    }
  }

  const counts = tally(picks);
  const slowShare = counts.get(slow) / picks.length;
  assert.ok(slowShare < 0.3, `慢后端占比应低于 30%，实际 ${slowShare}`);
  assert.ok(counts.get(slow) > 0, '慢后端不应被完全饿死，仍承担溢出流量');
});

test('连接复用失败：惩罚期内优先其他实例，成功后恢复', () => {
  let clock = 1000;
  const selector = makeSelector(3, { now: () => clock });
  const [bad] = [...selector.endpoints.keys()];

  selector.recordReuseFailure(bad, clock);
  let picks = Array.from({ length: 60 }, () => selector.select());
  assert.ok(!picks.includes(bad), '惩罚期内评分翻倍，不应被选中');

  clock += 501;
  picks = Array.from({ length: 30 }, () => selector.select());
  assert.ok(picks.includes(bad), '惩罚过期后应恢复参与选择');

  selector.recordReuseFailure(bad, clock);
  assert.ok(!Array.from({ length: 20 }, () => selector.select()).includes(bad));
  selector.recordReuseSuccess(bad);
  assert.ok(Array.from({ length: 20 }, () => selector.select()).includes(bad));
});

test('会话亲和：同一 key 固定映射，key 分布均匀，过载时熔断并可重试', () => {
  const selector = makeSelector(3);
  const ids = [...selector.endpoints.keys()];

  assert.equal(selector.select('session-1'), selector.select('session-1'));
  assert.equal(selector.select('session-2'), selector.select('session-2'));

  const counts = tally(
    Array.from({ length: 300 }, (_, index) => selector.select(`user-${index}`)),
  );
  for (const id of ids) {
    const share = counts.get(id) / 300;
    assert.ok(Math.abs(share - 1 / 3) < 0.08, `HRW 分布应大致均匀，${id} 占比 ${share}`);
  }

  const key = 'pinned-session';
  const pinned = selector.select(key);
  const alternative = selector.nextAlternative(pinned, key);
  assert.ok(alternative && alternative !== pinned, '重试备选必须排除刚失败的实例');
  assert.ok(ids.includes(alternative));
  assert.equal(
    selector.nextAlternative(pinned, key),
    alternative,
    '相同 key 的重试选择同样具有确定性',
  );

  const target = selector.getEndpoint(pinned);
  target.inFlight = 50;
  const fallback = selector.select(key);
  assert.notEqual(fallback, pinned, '粘性实例显著过载时应放弃会话亲和');
});

test('权重变化：高权重实例按容量获得更高流量占比', () => {
  const selector = makeSelector(3);
  const [heavy, ,] = [...selector.endpoints.keys()];
  selector.setWeight(heavy, 2);

  let state = 0x1234 >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const picks = [];
  for (let step = 0; step < 2000; step += 1) {
    picks.push(selector.selectAndBegin());
    // 每个在途请求以固定概率完成，模拟稳态服务速率
    for (const endpoint of selector.endpoints.values()) {
      let remaining = endpoint.inFlight;
      for (let i = 0; i < endpoint.inFlight; i += 1) {
        if (random() < 0.5) remaining -= 1;
      }
      endpoint.inFlight = remaining;
    }
  }

  const counts = tally(picks);
  const heavyShare = counts.get(heavy) / picks.length;
  assert.ok(
    heavyShare > 0.58 && heavyShare < 0.7,
    `权重 2x 的节点应承担约 2x 流量（~0.63），实际 ${heavyShare}`,
  );

  selector.setWeight(heavy, 0);
  assert.ok(!Array.from({ length: 30 }, () => selector.select()).includes(heavy));
});

test('健康摘除：检查失败平滑降权，连续失败彻底摘除', () => {
  const selector = makeSelector(3);
  const victim = [...selector.endpoints.keys()][0];
  const endpoint = selector.getEndpoint(victim);

  selector.recordHealthCheck(victim, false);
  assert.equal(endpoint.state, HealthState.DRAINING);
  assert.equal(endpoint.ramp, 0.5);
  assert.equal(selector.explain(victim).state, HealthState.DRAINING);

  selector.recordHealthCheck(victim, false);
  assert.equal(endpoint.state, HealthState.UNHEALTHY);
  assert.equal(endpoint.ramp, 0);
  for (let i = 0; i < 40; i += 1) {
    assert.notEqual(selector.select(), victim, 'ramp=0 的实例不应再接收新流量');
  }
});

test('健康恢复：预热实例逐步加回，最终恢复全量流量', () => {
  const selector = makeSelector(3);
  const victim = [...selector.endpoints.keys()][0];
  const endpoint = selector.getEndpoint(victim);

  selector.recordHealthCheck(victim, false);
  selector.recordHealthCheck(victim, false);
  assert.equal(endpoint.state, HealthState.UNHEALTHY);

  const ramps = [];
  for (let i = 0; i < 4; i += 1) {
    selector.recordHealthCheck(victim, true);
    ramps.push(endpoint.ramp);
  }
  assert.deepEqual(ramps, [0.25, 0.5, 0.75, 1]);
  assert.equal(endpoint.state, HealthState.HEALTHY);

  const picks = tally(
    Array.from({ length: 300 }, (_, step) => {
      const id = selector.selectAndBegin();
      if (step % 2 === 0) {
        for (const ep of selector.endpoints.values()) {
          ep.inFlight = Math.max(0, ep.inFlight - 1);
        }
      }
      return id;
    }),
  );
  const share = picks.get(victim) / 300;
  assert.ok(Math.abs(share - 1 / 3) < 0.06, `恢复后应均分流量，实际 ${share}`);
});

test('无可用实例时返回 null，重新加回后恢复选择', () => {
  const selector = makeSelector(2);
  for (const id of selector.endpoints.keys()) {
    selector.recordHealthCheck(id, false);
    selector.recordHealthCheck(id, false);
  }
  assert.equal(selector.select(), null);
  assert.equal(selector.selectAndBegin(), null);
  assert.equal(selector.nextAlternative(null), null);

  const first = [...selector.endpoints.keys()][0];
  for (let i = 0; i < 4; i += 1) {
    selector.recordHealthCheck(first, true);
  }
  assert.equal(selector.select(), first);
});

test('当前连接数通过 connectionWeight 计入负载，区别于在途请求', () => {
  const selector = makeSelector(2, { connectionWeight: 0.5 });
  const [busy, idle] = [...selector.endpoints.keys()];
  selector.updateMetrics(busy, { activeConnections: 100, inFlight: 0 });
  selector.updateMetrics(idle, { activeConnections: 0, inFlight: 0 });

  const picks = Array.from({ length: 50 }, () => selector.select());
  assert.ok(picks.filter((id) => id === idle).length > 40, '空闲连接多的实例应被少选');
});
