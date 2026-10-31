/**
 * 文字检查（编辑 > 检查拼写）。
 *
 * 说明白一件事：**这不是词典拼写检查**。真正的拼写检查需要一本词典（几十万字），
 * 与「零依赖、纯前端」的定位冲突，硬塞一个小词典只会误报。
 *
 * 这里做的是**可确证的排版错误检测** —— 这些错误不需要词典就能判定：
 * - 重复词：「the the」「的的」
 * - 中文里夹了英文但两边没空格（排版规范）
 * - 全角/半角标点混用
 * - 一句里连续多个空格
 * - 中文句末用了英文句点（或反之）
 * - 常见英文手误（teh → the 这类高频错拼，用一张小对照表）
 *
 * 每条都给出可自动修复的替换建议，纯函数、可单测。
 */

export type IssueKind =
  | "duplicate"
  | "spacing"
  | "fullwidth"
  | "doubleSpace"
  | "period"
  | "typo";

export interface Issue {
  kind: IssueKind;
  /** 在原文中的位置 */
  index: number;
  /** 命中的片段 */
  found: string;
  /** 建议替换成什么（空串 = 删除） */
  fix: string;
  message: string;
}

/** 高频英文错拼（只收「一定错」的，避免误报）。 */
const TYPOS: Record<string, string> = {
  teh: "the",
  adn: "and",
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  definately: "definitely",
  occured: "occurred",
  untill: "until",
  wich: "which",
  thier: "their",
  becuase: "because",
  alot: "a lot",
  accomodate: "accommodate",
  arguement: "argument",
  calender: "calendar",
  enviroment: "environment",
  existance: "existence",
  goverment: "government",
  independant: "independent",
  neccessary: "necessary",
  occassion: "occasion",
  publically: "publicly",
  reccomend: "recommend",
  succesful: "successful",
  tommorow: "tomorrow",
  werid: "weird",
};

const CJK = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z0-9]/;

/** 检查一段文字，按位置排序返回问题列表。 */
export function checkText(content: string): Issue[] {
  const issues: Issue[] = [];
  const text = content.replace(/\r\n?/g, "\n");

  // 1) 重复词：英文按「整词重复」，中文按「2~4 字词组重复」（中文没空格，不能按词切）
  let m: RegExpExecArray | null;
  const dupEn = /\b([A-Za-z]{2,})(\s+\1\b)/g;
  while ((m = dupEn.exec(text)) !== null) {
    issues.push({ kind: "duplicate", index: m.index, found: m[0], fix: m[1], message: "重复词" });
  }
  const dupCjk = /([\u4e00-\u9fff]{2,4})\1/g;
  while ((m = dupCjk.exec(text)) !== null) {
    issues.push({ kind: "duplicate", index: m.index, found: m[0], fix: m[1], message: "重复词" });
  }

  // 2) 中英之间缺空格
  for (let i = 1; i < text.length; i += 1) {
    const prev = text[i - 1];
    const cur = text[i];
    if ((CJK.test(prev) && LATIN.test(cur)) || (LATIN.test(prev) && CJK.test(cur))) {
      issues.push({
        kind: "spacing",
        index: i - 1,
        found: prev + cur,
        fix: `${prev} ${cur}`,
        message: "中英文之间建议加空格",
      });
    }
  }

  // 3) 全角/半角混用（中文里出现半角逗号句号，或英文里出现全角）
  const halfPunct = /[,;:!?]/g;
  while ((m = halfPunct.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (CJK.test(before)) {
      const map: Record<string, string> = { ",": "，", ";": "；", ":": "：", "!": "！", "?": "？" };
      issues.push({
        kind: "fullwidth",
        index: m.index,
        found: m[0],
        fix: map[m[0]],
        message: "中文里用了半角标点",
      });
    }
  }

  // 4) 连续空格
  const spaceRe = / {2,}/g;
  while ((m = spaceRe.exec(text)) !== null) {
    issues.push({
      kind: "doubleSpace",
      index: m.index,
      found: `${m[0].length} 个空格`,
      fix: " ",
      message: "多余的空格",
    });
  }

  // 5) 中文句末用了英文句点
  const periodRe = /[\u4e00-\u9fff]\.(?=\s|$|[A-Za-z])/g;
  while ((m = periodRe.exec(text)) !== null) {
    issues.push({
      kind: "period",
      index: m.index + 1,
      found: "。",
      fix: "。",
      message: "中文句末建议用「。」",
    });
  }

  // 6) 常见错拼
  const wordRe = /\b[A-Za-z]+\b/g;
  while ((m = wordRe.exec(text)) !== null) {
    const lower = m[0].toLowerCase();
    const right = TYPOS[lower];
    if (!right) continue;
    // 保留原大小写风格：首字母大写则修正后也大写
    const fixed = m[0][0] === m[0][0].toUpperCase() ? right[0].toUpperCase() + right.slice(1) : right;
    issues.push({
      kind: "typo",
      index: m.index,
      found: m[0],
      fix: fixed,
      message: "常见错拼",
    });
  }

  return issues.sort((a, b) => a.index - b.index);
}

/** 按问题列表批量修正（从后往前替换，避免位置错位）。 */
export function applyFixes(content: string, issues: Issue[]): string {
  let out = content;
  const sorted = issues.slice().sort((a, b) => b.index - a.index);
  for (const it of sorted) {
    const len = it.kind === "doubleSpace" ? Number.parseInt(it.found, 10) || 2 : it.found.length;
    out = out.slice(0, it.index) + it.fix + out.slice(it.index + len);
  }
  return out;
}

/** 问题分类的显示名。 */
export const ISSUE_LABEL: Record<IssueKind, string> = {
  duplicate: "重复",
  spacing: "空格",
  fullwidth: "标点",
  doubleSpace: "空格",
  period: "标点",
  typo: "拼写",
};
