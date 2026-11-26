/**
 * 径向 / 曼陀罗对称的几何纯函数。
 *
 * 把落点绕中心旋转到 N 个扇区；打开镜像时再补一组上下翻转后的旋转点，
 * 得到常见的曼陀罗对称。只吃数字和点，不碰 Canvas / DOM，便于单测钉死
 * 扇区数、镜像语义和退化输入。
 */

export interface RadialPoint {
  x: number;
  y: number;
}

export interface RadialConfig {
  /** 扇区数，夹到 2–32 */
  sectors: number;
  /** 每个扇区是否再镜像一份 */
  mirror?: boolean;
  /** 对称中心；null / 缺省由调用方传画布中心 */
  center?: RadialPoint | null;
}

const TAU = Math.PI * 2;

export function clampRadialSectors(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(2, Math.min(32, Math.round(value)));
}

/**
 * 返回这一笔尖需要补落的全部位置。
 *
 * 镜像 = 先把相对中心向量上下翻转，再按同一组角度旋转；这样偶数扇区得到
 * 左右配对，奇数扇区也不会把镜像退化成同一组点。中心点、NaN 坐标都安全。
 */
export function radialPoints(
  x: number,
  y: number,
  config: RadialConfig,
): RadialPoint[] {
  const n = clampRadialSectors(config.sectors);
  const center = config.center ?? { x: 0, y: 0 };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  const dx = x - center.x;
  const dy = y - center.y;
  const out: RadialPoint[] = [];
  const seen = new Set<string>();
  const push = (px: number, py: number) => {
    // 坐标量化到 1/1000 像素去重：镜像轴上的点不该被重复落两次笔尖
    const key = `${Math.round(px * 1000)}:${Math.round(py * 1000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x: px, y: py });
  };
  for (let i = 0; i < n; i += 1) {
    const a = (TAU * i) / n;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    push(center.x + dx * cos - dy * sin, center.y + dx * sin + dy * cos);
    if (config.mirror) {
      push(center.x + dx * cos + dy * sin, center.y + dx * sin - dy * cos);
    }
  }
  return out;
}

/** 距离保持不变：径向复制只改位置，不改笔尖大小 / 压感 / 流量。 */
export function radialDistanceToCenter(
  p: RadialPoint,
  center: RadialPoint,
): number {
  return Math.hypot(p.x - center.x, p.y - center.y);
}

/**
 * 从画笔 / 涂抹选项派生引擎用的径向配置。
 *
 * 只有 `symmetry === "radial"` 才返回配置；扇区数在这里统一夹取，
 * 避免画笔和涂抹两条管线各自写一份导致行为分叉。`fallbackCenter`
 * 由调用方给画布中心，配置没显式设中心时用它。
 */
export function radialConfigFrom(
  settings: {
    symmetry?: string | null;
    radialSectors?: number;
    radialMirror?: boolean;
    radialCenter?: RadialPoint | null;
  } | null | undefined,
  fallbackCenter?: RadialPoint | null,
): RadialConfig | null {
  if (!settings || settings.symmetry !== "radial") return null;
  return {
    sectors: clampRadialSectors(settings.radialSectors ?? 6),
    mirror: settings.radialMirror === true,
    center: settings.radialCenter ?? fallbackCenter ?? null,
  };
}
