import { useId } from "react";
import { BRAND_GLYPH } from "./brandGlyph";

/**
 * 品牌标识，严格按 `assets/brand/` 的素材复刻成三层：
 *
 * 1. **品牌蓝底盘** `#6fc0ff` —— 就是原始素材最外圈那抹蓝，也是全应用的唯一强调色。
 *    这一层必须画出来，它才是 Logo 的「那一圈蓝框」；生成应用图标时才去掉它。
 * 2. **深灰方块**，四周内缩 3 个单位，铺一层「左下偏暗、右上偏亮」的对角渐变
 *    （实测极值约 `#242424` → `#565656`），复刻素材里那块金属质感的底。
 * 3. **白色 `St` 字标**，矢量轮廓见 `brandGlyph.ts`。
 *
 * 标的整体为**方角**：素材本身就是满幅方角，故此处不额外加圆角，以免和素材长得不一样。
 * 蓝色写死不跟随主题——品牌标识在两套主题下必须是同一个蓝，不参与配色切换。
 */
export default function BrandMark({ size = 32 }: { size?: number }) {
  // 同一页面可能有多个标识（开始页顶部、空状态、关于浮层…），
  // 渐变 id 必须逐实例唯一，否则会互相抢占引用。
  const gid = `strata-brand-${useId().replace(/:/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Strata 标识"
      style={{ display: "block", flex: "none" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#242424" />
          <stop offset="1" stopColor="#565656" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" fill="#6fc0ff" />
      <rect x="3" y="3" width="58" height="58" fill={`url(#${gid})`} />
      <path d={BRAND_GLYPH} fill="#ffffff" fillRule="evenodd" />
    </svg>
  );
}
