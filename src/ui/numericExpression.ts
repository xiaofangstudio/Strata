/**
 * 专业数值框的表达式解析（纯函数，不碰 DOM）。
 *
 * PhotoCraft 的 `numeric_expression` / `value_field_units` 允许专业用户直接键入
 * `120+10`、`50%`、`2in` 这类表达式，而不是被迫一段段拖滑杆。我们这里实现同一
 * 件事的轻量版：**手写递归下降，绝不用 eval**（WebView2 里 eval 既是注入面，
 * 也无法给出可读的错误位置）。
 *
 * 支持：
 *   · 四则运算 + 括号：`120+10`、`(40+8)*2`、`100/4`
 *   · 后缀单位：`%`（相对 min..max 区间）、`px` / `in` / `cm` / `mm` / `pt`（按 dpi 换算）
 *   · 相对调整：`+=12` / `-=5`（在当前值上增减，避免 `-5` 与负数值的歧义）
 *   · 结果一律 clamp 到 [min,max]
 */
export interface NumericParseOptions {
  min: number;
  max: number;
  /** 相对调整 `+=` / `-=` 的基准；不传则相对调整无效 */
  current?: number;
  /** 单位换算用的分辨率，默认 96 dpi */
  dpi?: number;
}

export interface NumericParseResult {
  ok: boolean;
  value: number;
  /** 出错时的简短原因（给 title 提示用） */
  error?: string;
}

type Token = { kind: "num" | "op" | "lp" | "rp" | "unit"; text: string };

const UNIT_SCALE: Record<string, (dpi: number) => number> = {
  px: () => 1,
  in: (dpi) => dpi,
  inch: (dpi) => dpi,
  cm: (dpi) => dpi / 2.54,
  mm: (dpi) => dpi / 25.4,
  pt: (dpi) => dpi / 72,
};

/** 把输入切成词法单元；遇到非法字符直接失败。 */
function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      if ((text.match(/\./g) ?? []).length > 1) return null;
      out.push({ kind: "num", text });
      i = j;
      continue;
    }
    if (/[a-zA-Z%]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z%]/.test(src[j])) j += 1;
      out.push({ kind: "unit", text: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      out.push({ kind: "op", text: c });
      i += 1;
      continue;
    }
    if (c === "(") {
      out.push({ kind: "lp", text: c });
      i += 1;
      continue;
    }
    if (c === ")") {
      out.push({ kind: "rp", text: c });
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * 解析数值输入。永远返回有限数（失败时返回当前值或 min），调用方不必再兜底。
 */
export function parseNumericExpression(raw: string, opts: NumericParseOptions): NumericParseResult {
  const { min, max } = opts;
  const dpi = opts.dpi ?? 96;
  const fallback = Number.isFinite(opts.current) ? (opts.current as number) : min;
  const bad = (error: string): NumericParseResult => ({ ok: false, value: fallback, error });
  const src = raw.trim();
  if (!src) return bad("empty");

  // 相对调整：只在显式 += / -= 时启用，语法最不易误伤负数输入。
  const rel = /^([+-])=(.+)$/.exec(src);
  const body = rel ? rel[2] : src;
  const tokens = tokenize(body);
  if (!tokens || tokens.length === 0) return bad("syntax");

  let pos = 0;
  const peek = () => tokens[pos];

  const parsePrimary = (): number => {
    const t = peek();
    if (!t) throw new Error("syntax");
    if (t.kind === "lp") {
      pos += 1;
      const v = parseExpr();
      if (peek()?.kind !== "rp") throw new Error("paren");
      pos += 1;
      return v;
    }
    if (t.kind === "op" && (t.text === "+" || t.text === "-")) {
      pos += 1;
      const v = parsePrimary();
      return t.text === "-" ? -v : v;
    }
    if (t.kind !== "num") throw new Error("syntax");
    pos += 1;
    let v = Number(t.text);
    if (!Number.isFinite(v)) throw new Error("syntax");
    const u = peek();
    if (u?.kind === "unit") {
      pos += 1;
      if (u.text === "%") v = min + (v / 100) * (max - min);
      else {
        const scale = UNIT_SCALE[u.text];
        if (!scale) throw new Error("unit");
        v *= scale(dpi);
      }
    }
    return v;
  };

  const parseTerm = (): number => {
    let v = parsePrimary();
    for (;;) {
      const t = peek();
      if (!t || t.kind !== "op" || (t.text !== "*" && t.text !== "/")) break;
      pos += 1;
      const r = parsePrimary();
      if (t.text === "/" && r === 0) throw new Error("div0");
      v = t.text === "*" ? v * r : v / r;
    }
    return v;
  };

  const parseExpr = (): number => {
    let v = parseTerm();
    for (;;) {
      const t = peek();
      if (!t || t.kind !== "op" || (t.text !== "+" && t.text !== "-")) break;
      pos += 1;
      const r = parseTerm();
      v = t.text === "+" ? v + r : v - r;
    }
    return v;
  };

  let value: number;
  try {
    value = parseExpr();
    if (pos !== tokens.length) return bad("trailing");
    if (!Number.isFinite(value)) return bad("range");
  } catch (e) {
    return bad(e instanceof Error ? e.message : "syntax");
  }

  if (rel) {
    if (!Number.isFinite(opts.current)) return bad("relative");
    value = (opts.current as number) + (rel[1] === "+" ? value : -value);
  }
  const clamped = Math.min(max, Math.max(min, value));
  return { ok: true, value: clamped };
}
