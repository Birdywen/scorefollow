// 散点图降载: 音符多时按列分桶, 每桶只画偏差最大的 1 个音, 点击回听保留到该音。
// 音数 <= 容量时原样返回, 渲染路径与之前完全一致。
export const SCATTER_CAPACITY = 96;

export type Bucket<T> = { item: T; count: number };

export function downsampleBy<T>(items: T[], capacity: number, score: (item: T) => number): Bucket<T>[] {
  if (items.length <= capacity || capacity < 1) return items.map((item) => ({ item, count: 1 }));
  const out: Bucket<T>[] = [];
  const n = items.length;
  for (let b = 0; b < capacity; b++) {
    const start = Math.floor((b * n) / capacity);
    const end = Math.floor(((b + 1) * n) / capacity);
    let best = start;
    for (let i = start + 1; i < end; i++) {
      if (score(items[i]) > score(items[best])) best = i;
    }
    out.push({ item: items[best], count: end - start });
  }
  return out;
}
