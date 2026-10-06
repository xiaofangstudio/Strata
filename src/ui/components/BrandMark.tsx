/**
 * 品牌标识：深灰圆角方块 + 白色 St 字标。
 * 用 SVG 现场绘制，避免为一个小标额外打包位图资源。
 */
export default function BrandMark({ size = 32 }: { size?: number }) {
  const r = Math.round(size * 0.25);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Strata 标识"
      style={{ display: "block", flex: "none" }}
    >
      <rect x="0" y="0" width="64" height="64" rx={r * (64 / size)} fill="#3d3d3d" />
      <text
        x="32"
        y="34"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="system-ui, 'Segoe UI', sans-serif"
        fontSize="31"
        fontWeight="600"
        letterSpacing="-0.5"
        fill="#ffffff"
      >
        St
      </text>
    </svg>
  );
}
