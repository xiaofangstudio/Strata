import markSrc from "../../assets/strata-mark.png";

/**
 * 品牌标识（应用内）。
 *
 * 换新 logo 后这里不再用 SVG 描摹旧字标 —— 之前是「蓝底 + 深灰渐变 + 白色 St 轮廓」
 * 三层手绘复刻，图一换就得重新描一遍路径，成本高且容易走样。
 * 现在直接用与应用图标同源的那张图，**视觉上和应用图标是同一个东西**。
 *
 * 圆角用 23%：与应用图标的超椭圆（n=5）在 16–32px 这个尺寸下肉眼无差，
 * 但不用 clip-path 画超椭圆，省一层合成，小图标渲染更稳。
 */
export default function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <img
      src={markSrc}
      width={size}
      height={size}
      alt="Strata 标识"
      draggable={false}
      style={{
        display: "block",
        flex: "none",
        width: size,
        height: size,
        objectFit: "cover",
        borderRadius: "23%",
        userSelect: "none",
      }}
    />
  );
}
