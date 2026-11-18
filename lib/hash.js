/**
 * FNV-1a 32 位哈希，用于会话 key 的确定性 Rendezvous Hashing (HRW)。
 * 不依赖随机种子，成员变化时会话映射尽可能稳定。
 */
export function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // murmur3 finalizer：打散短且近似的输入（如 user-1/user-2）带来的相关性
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
