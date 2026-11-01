/**
 * Alpha 轮廓描迹（文件 > 导出 > 路径到 Illustrator 的内核）。
 *
 * Strata 没有矢量路径对象（这是如实声明的），但「把图层剪影交给
 * Illustrator 继续加工」这件事可以真做：把 Alpha 按阈值二值化，
 * 用 marching-squares 的边沿法逐像素发出有向边（不透明区总在行进方向左侧），
 * 再把边链成闭合环 —— 外轮廓与洞都能正确拿到。
 *
 * 全部是纯像素函数：Uint8ClampedArray 进、点列出，不碰任何浏览器 API。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 一个闭合环（外轮廓或洞），点按整数格点给出。 */
export type Loop = Pt[];

/**
 * 描出 Alpha≥threshold 的全部闭合轮廓。
 *
 * 返回的环不区分外轮廓与洞；导出时用 SVG 的 evenodd 填充规则即可正确挖洞。
 * 点已做共线合并，矩形就是 4 个点，不会把每个台阶都存下来。
 */
export function traceAlphaLoops(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 128,
): Loop[] {
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] >= threshold;

  // 有向边表：起点 → 终点。同一起点最多两条出边（对角接触的病态情形），
  // 这里用数组挂链保证不丢环。
  const edges = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (width + 1) + x;
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    const list = edges.get(k);
    if (list) list.push(key(bx, by));
    else edges.set(k, [key(bx, by)]);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!solid(x, y)) continue;
      // 上边：邻居 (x, y-1) 透明才发出，行进方向使不透明区在左侧
      if (!solid(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!solid(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!solid(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!solid(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops: Loop[] = [];
  const toPt = (k: number): Pt => ({ x: k % (width + 1), y: Math.floor(k / (width + 1)) });

  while (edges.size > 0) {
    // 任取一条未用的边开始走环
    const startK = edges.keys().next().value as number;
    const loop: Loop = [];
    let cur = startK;
    let guard = 0;
    const limit = width * height * 4 + 8;
    for (;;) {
      const outs = edges.get(cur);
      if (!outs || outs.length === 0) break; // 不该发生：边总是成环
      const nextK = outs.pop()!;
      if (outs.length === 0) edges.delete(cur);
      loop.push(toPt(cur));
      cur = nextK;
      guard += 1;
      if (guard > limit) break; // 防御：坏数据不至于把内存吃穿
      if (cur === startK) break;
    }
    if (loop.length >= 4) loops.push(mergeCollinear(loop));
  }
  return loops;
}

/** 合并共线点：矩形环合并后只剩 4 个角。 */
function mergeCollinear(loop: Loop): Loop {
  if (loop.length < 3) return loop;
  const out: Loop = [];
  for (let i = 0; i < loop.length; i += 1) {
    const a = out[out.length - 1] ?? loop[loop.length - 1];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross !== 0) out.push(b);
  }
  return out;
}

/** 把环转成 SVG path 的 d 值（evenodd 填充，洞自动镂空）。 */
export function loopsToSvgPath(loops: Loop[]): string {
  return loops
    .map((lp) => {
      const head = lp[0];
      const rest = lp.slice(1).map((p) => `L${p.x} ${p.y}`).join("");
      return `M${head.x} ${head.y}${rest}Z`;
    })
    .join("");
}

/** 组装一份可直接交给 Illustrator 打开的 SVG 文档。 */
export function loopsToSvg(
  loops: Loop[],
  width: number,
  height: number,
  fill = "#000000",
): string {
  const d = loopsToSvgPath(loops);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`,
    "</svg>",
    "",
  ].join("\n");
}
