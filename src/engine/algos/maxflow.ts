/**
 * GrabCut 用图割最小割（网格图 + push-relabel 最大流）。
 *
 * 参考 ArtCraft PhotoCraft crates/algo/src/segment/maxflow.rs 的契约与能量模型，
 * 这里用更紧凑的 FIFO push-relabel 实现（同样的 Boykov 能量，不逐行照搬 BK 搜索树）。
 * MIT / Apache-2.0 来源声明保留。
 */
const EPS = 1e-5;
const INF = 1e9;

/** trimap 标签（GrabCut 内部状态）。 */
export const FG = 1;
export const BG = 0;
export const PR_FG = 3;
export const PR_BG = 2;

/** fixed 标签：必须与 trimap 标签分开，否则 BG(0) 会把自由像素全吞成硬背景。 */
export const FREE = 0;
export const HARD_FG = 2;
export const HARD_BG = 3;

export interface CutOptions {
  /** 数据项：像素判为前景的代价。 */
  fgCost: Float32Array;
  /** 数据项：像素判为背景的代价。 */
  bgCost: Float32Array;
  /** FREE=自由，HARD_FG=硬前景，HARD_BG=硬背景。 */
  fixed: Uint8Array;
  /** 相邻像素平滑项；返回非负值。 */
  smooth: (a: number, b: number) => number;
}

/** 4 邻域网格图上的最小割：返回 1=前景(source side)，0=背景。 */
export function gridMinCut(w: number, h: number, opts: CutOptions): Uint8Array {
  const n = w * h;
  const source = n;
  const sink = n + 1;
  const N = n + 2;
  const head = new Int32Array(N).fill(-1);
  const to: number[] = [];
  const next: number[] = [];
  const cap: number[] = [];

  const addEdge = (u: number, v: number, c: number, rev: number): void => {
    to.push(v); cap.push(c); next.push(head[u]); head[u] = to.length - 1;
    to.push(u); cap.push(rev); next.push(head[v]); head[v] = to.length - 1;
  };

  for (let i = 0; i < n; i += 1) {
    if (opts.fixed[i] === HARD_FG) {
      addEdge(source, i, INF, 0);
    } else if (opts.fixed[i] === HARD_BG) {
      addEdge(i, sink, INF, 0);
    } else {
      addEdge(source, i, Math.max(0, opts.bgCost[i]), 0);
      addEdge(i, sink, Math.max(0, opts.fgCost[i]), 0);
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x + 1 < w) {
        const s = Math.max(0, opts.smooth(i, i + 1));
        addEdge(i, i + 1, s, s);
      }
      if (y + 1 < h) {
        const s = Math.max(0, opts.smooth(i, i + w));
        addEdge(i, i + w, s, s);
      }
    }
  }

  // ---- FIFO push-relabel
  const excess = new Float64Array(N);
  const height = new Int32Array(N);
  height[source] = N;
  // 用可增长队列：push-relabel 的重入次数不设固定上界，定长环形队列在大图上会覆盖未处理节点。
  const queue: number[] = [];
  let qh = 0;
  const inQueue = new Uint8Array(N);
  const push = (e: number, amount: number): void => {
    cap[e] -= amount;
    cap[e ^ 1] += amount;
    excess[to[e]] += amount;
    excess[to[e ^ 1]] -= amount;
  };
  const enqueue = (v: number): void => {
    if (v === source || v === sink || inQueue[v]) return;
    queue.push(v);
    inQueue[v] = 1;
  };

  for (let e = head[source]; e !== -1; e = next[e]) {
    if (cap[e] > EPS) {
      const c = cap[e];
      push(e, c);
    }
  }
  for (let i = 0; i < n; i += 1) if (excess[i] > EPS) enqueue(i);

  while (qh < queue.length) {
    const u = queue[qh];
    qh += 1;
    inQueue[u] = 0;
    while (excess[u] > EPS) {
      let pushed = false;
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (cap[e] <= EPS || height[u] !== height[to[e]] + 1) continue;
        const amount = Math.min(excess[u], cap[e]);
        push(e, amount);
        enqueue(to[e]);
        pushed = true;
        break;
      }
      if (pushed) continue;
      let minH = Infinity;
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (cap[e] > EPS) minH = Math.min(minH, height[to[e]]);
      }
      if (!Number.isFinite(minH)) {
        excess[u] = 0; // 不可达残余，放弃该节点的超额
        break;
      }
      height[u] = minH + 1;
    }
  }

  // ---- source side = foreground
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  let top = 0;
  stack[top++] = source;
  seen[source] = 1;
  while (top > 0) {
    const u = stack[--top];
    for (let e = head[u]; e !== -1; e = next[e]) {
      const v = to[e];
      if (cap[e] <= EPS || seen[v]) continue;
      seen[v] = 1;
      stack[top++] = v;
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = seen[i] ? 1 : 0;
  return out;
}
