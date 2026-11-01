// 临时审计：列出仍置灰的菜单项（按组）。跑完即删。
import { readFileSync, writeFileSync } from "node:fs";

const root = "D:/20533/deskbox/fangwork/Strata";
const cat = readFileSync(`${root}/src/ui/components/menuCatalog.data.ts`, "utf8");
const shell = readFileSync(`${root}/src/ui/EditorShell.tsx`, "utf8");
const defs = readFileSync(`${root}/src/engine/filters/defs.ts`, "utf8");

const rows = [...cat.matchAll(/\["([^"]+)",\s*"([^"]*)",\s*"[^"]*",\s*"([^"]+)"\]/g)].map(
  (m) => ({ path: m[1], label: m[2], id: m[3] }),
);

const cases = new Set([...shell.matchAll(/case "([^"]+)"/g)].map((m) => m[1]));
const filterIds = new Set([...defs.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]));

const groups = new Map();
for (const r of rows) {
  const g = r.path.split(".")[0];
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

const grey = [];
for (const [g, list] of groups) {
  for (const r of list) {
    const taken = cases.has(r.id) || filterIds.has(r.id);
    if (!taken) grey.push({ group: g, path: r.path, label: r.label, id: r.id });
  }
}

console.log(`总条目 ${rows.length}，已接管 ${rows.length - grey.length}，仍置灰 ${grey.length}`);
for (const it of grey) console.log(`[${it.group}] ${it.path}  ${it.label}  (id=${it.id})`);

const counts = {};
for (const it of grey) counts[it.group] = (counts[it.group] || 0) + 1;
console.log(JSON.stringify(counts));
