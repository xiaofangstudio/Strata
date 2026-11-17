/**
 * GrabCut 用到的 RGB 高斯混合模型（GMM）。
 *
 * Ported from ArtCraft PhotoCraft (crates/algo/src/segment/gmm.rs), MIT / Apache-2.0。
 * 全协方差 3×3；k-means++ 播种 + Lloyd + EM；协方差加 ridge 保证平坦区域可逆。
 */
export type Rgb = readonly [number, number, number];

interface Component {
  weight: number;
  mean: [number, number, number];
  inv: number[][];
  logNorm: number;
}

const REG = 2e-5;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function d2(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** 3×3 对称矩阵求逆；奇异返回 null。 */
function inv3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0];
  const d = m[1][1];
  const e = m[1][2];
  const f = m[2][2];
  const A = d * f - e * e;
  const B = c * e - b * f;
  const C = b * e - c * d;
  const D = a * f - b * b;
  const E = b * c - a * e;
  const F = a * d - b * b;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  return [
    [A / det, B / det, C / det],
    [B / det, D / det, E / det],
    [C / det, E / det, F / det],
  ];
}

function componentFrom(
  samples: readonly Rgb[],
  weights: Float64Array,
  total: number,
): Component | null {
  if (total <= 0) return null;
  const mean: [number, number, number] = [0, 0, 0];
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < samples.length; i += 1) {
    const w = weights[i];
    if (w <= 0) continue;
    const s = samples[i];
    mean[0] += w * s[0];
    mean[1] += w * s[1];
    mean[2] += w * s[2];
  }
  mean[0] /= total;
  mean[1] /= total;
  mean[2] /= total;
  for (let i = 0; i < samples.length; i += 1) {
    const w = weights[i];
    if (w <= 0) continue;
    const s = samples[i];
    const v = [s[0] - mean[0], s[1] - mean[1], s[2] - mean[2]];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) cov[r][c] += w * v[r] * v[c];
    }
  }
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) cov[r][c] = cov[r][c] / total;
    cov[r][r] += REG;
  }
  const inv = inv3(cov);
  if (!inv) return null;
  const det = cov[0][0] * (cov[1][1] * cov[2][2] - cov[1][2] * cov[2][1]) -
    cov[0][1] * (cov[1][0] * cov[2][2] - cov[1][2] * cov[2][0]) +
    cov[0][2] * (cov[1][0] * cov[2][1] - cov[1][1] * cov[2][0]);
  if (!Number.isFinite(det) || det <= 0) return null;
  return {
    weight: total,
    mean,
    inv,
    logNorm: Math.log(total) - 0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI),
  };
}

function logWeighted(c: Component, z: Rgb): number {
  const d = [z[0] - c.mean[0], z[1] - c.mean[1], z[2] - c.mean[2]];
  let q = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let k = 0; k < 3; k += 1) q += d[r] * c.inv[r][k] * d[k];
  }
  return c.logNorm - 0.5 * q;
}

/** 对样本下采样，保持确定性且上限固定。 */
export function subsample(samples: readonly Rgb[], max: number): Rgb[] {
  if (samples.length <= max) return samples.slice();
  const step = samples.length / max;
  const out: Rgb[] = [];
  for (let i = 0; i < max; i += 1) out.push(samples[Math.floor(i * step)]);
  return out;
}

export class Gmm {
  private constructor(readonly comps: Component[]) {}

  /** k-means++ + Lloyd + EM 拟合 K 个分量。 */
  static fit(samples: readonly Rgb[], k = 5): Gmm | null {
    if (samples.length === 0) return null;
    const kk = Math.min(k, samples.length);
    const rand = rng(0x5eed);
    const centers: Rgb[] = [samples[Math.floor(rand() * samples.length)]];
    const nearest = new Float64Array(samples.length).fill(Infinity);
    while (centers.length < kk) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        nearest[i] = Math.min(nearest[i], d2(samples[i], centers[centers.length - 1]));
        sum += nearest[i];
      }
      if (sum <= 1e-12) break;
      let t = rand() * sum;
      let pick = samples.length - 1;
      for (let i = 0; i < samples.length; i += 1) {
        t -= nearest[i];
        if (t <= 0) { pick = i; break; }
      }
      centers.push(samples[pick]);
    }

    const labels = new Int32Array(samples.length);
    for (let iter = 0; iter < 6; iter += 1) {
      let moved = 0;
      for (let i = 0; i < samples.length; i += 1) {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < centers.length; c += 1) {
          const dd = d2(samples[i], centers[c]);
          if (dd < bestD) { bestD = dd; best = c; }
        }
        if (labels[i] !== best) { labels[i] = best; moved += 1; }
      }
      for (let c = 0; c < centers.length; c += 1) {
        let n = 0;
        const s = [0, 0, 0];
        for (let i = 0; i < samples.length; i += 1) {
          if (labels[i] !== c) continue;
          s[0] += samples[i][0]; s[1] += samples[i][1]; s[2] += samples[i][2]; n += 1;
        }
        if (n > 0) centers[c] = [s[0] / n, s[1] / n, s[2] / n];
      }
      if (moved === 0) break;
    }

    const weights = new Float64Array(samples.length);
    const comps: Component[] = centers
      .filter((_, c) => labels.includes(c))
      .map((center) => {
        let n = 0;
        for (let i = 0; i < samples.length; i += 1) {
          weights[i] = labels[i] === centers.indexOf(center) ? 1 : 0;
          n += weights[i];
        }
        return componentFrom(samples, weights, n);
      })
      .filter((c): c is Component => !!c);
    if (comps.length === 0) return null;

    for (let em = 0; em < 4; em += 1) {
      const acc = comps.map(() => ({ n: 0, s: [0, 0, 0], ss: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }));
      let total = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const vals = comps.map((c) => logWeighted(c, samples[i]));
        let mx = -Infinity;
        for (const v of vals) mx = Math.max(mx, v);
        const exps = vals.map((v) => Math.exp(Math.max(-700, v - mx)));
        const denom = exps.reduce((a, b) => a + b, 0) || 1;
        total += mx + Math.log(denom);
        for (let c = 0; c < comps.length; c += 1) {
          const w = exps[c] / denom;
          const a = acc[c];
          a.n += w;
          const z = samples[i];
          for (let r = 0; r < 3; r += 1) {
            a.s[r] += w * z[r];
            for (let col = 0; col < 3; col += 1) a.ss[r][col] += w * z[r] * z[col];
          }
        }
      }
      const next: Component[] = [];
      for (const a of acc) {
        if (a.n <= 0) continue;
        const mean: [number, number, number] = [a.s[0] / a.n, a.s[1] / a.n, a.s[2] / a.n];
        const w = new Float64Array(samples.length).fill(1);
        const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let r = 0; r < 3; r += 1) {
          for (let c = 0; c < 3; c += 1) cov[r][c] = a.ss[r][c] / a.n - mean[r] * mean[c];
          cov[r][r] += REG;
        }
        const inv = inv3(cov);
        if (!inv) continue;
        const det = cov[0][0] * (cov[1][1] * cov[2][2] - cov[1][2] * cov[2][1]) -
          cov[0][1] * (cov[1][0] * cov[2][2] - cov[1][2] * cov[2][0]) +
          cov[0][2] * (cov[1][0] * cov[2][1] - cov[1][1] * cov[2][0]);
        if (det <= 0) continue;
        next.push({
          weight: a.n / samples.length,
          mean,
          inv,
          logNorm: Math.log(a.n / samples.length) - 0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI),
        });
        void w;
      }
      if (next.length) {
        comps.length = 0;
        comps.push(...next);
      }
      void total;
    }
    return new Gmm(comps);
  }

  /** 每次 GrabCut 迭代后的重估：硬分配样本到最可能分量再重拟合。 */
  refit(samples: readonly Rgb[]): Gmm | null {
    if (samples.length === 0) return null;
    const labels = new Int32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      let best = 0;
      let bestV = -Infinity;
      for (let c = 0; c < this.comps.length; c += 1) {
        const v = logWeighted(this.comps[c], samples[i]);
        if (v > bestV) { bestV = v; best = c; }
      }
      labels[i] = best;
    }
    const weights = new Float64Array(samples.length);
    const comps: Component[] = [];
    for (let c = 0; c < this.comps.length; c += 1) {
      let n = 0;
      for (let i = 0; i < samples.length; i += 1) {
        weights[i] = labels[i] === c ? 1 : 0;
        n += weights[i];
      }
      const comp = componentFrom(samples, weights, n);
      if (comp) comps.push(comp);
    }
    return comps.length ? new Gmm(comps) : null;
  }

  /** 样本属于该模型的最大对数概率。 */
  logLikelihood(z: Rgb): number {
    let best = -Infinity;
    for (const c of this.comps) best = Math.max(best, logWeighted(c, z));
    return best;
  }
}
