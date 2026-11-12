// 「内容是否相同」的唯一口径：键序无关的 JSON 规范化。
//
// 同步链路里有两处独立的「同不同」判断，必须共用同一份实现：
// - `sync.ts` 的 `sameContentAsRemote()`：远端回声 vs 本地，决定要不要回推；
// - `syncResolve.ts` 的 `sameRecord()`：冲突决策，决定要不要记一条待核对。
//
// 为什么两套口径会打架：同样的数据在两端的键顺序天然不同（本地由对象字面量构造，
// 远端是 PostgREST 返回的 JSON，`id` 常常排在最前）。如果一处用 `JSON.stringify`
// 直接比较、另一处用键序无关比较，就会出现「冲突决策说不同、回推判断说相同」：
// 于是一边每轮同步都记一条假冲突，另一边又认为云端不需要更新 —— 云端永不收敛，
// `conflicts` 表无界增长，真正的冲突也被淹没。
//
// 所以这里只保留一份实现，任何新的「内容比较」都必须调用它。
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}