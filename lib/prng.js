/**
 * mulberry32：确定性 32 位种子伪随机数生成器。
 * 相同种子产生完全相同的随机序列，保证选择分布可复现。
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
