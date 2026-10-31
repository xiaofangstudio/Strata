/**
 * 极简 PDF 写出器（一页一张图）。
 *
 * 只为一个用途服务：把多张画板导出成一个多页 PDF。不做排版、不做字体，
 * 每页就是一张 JPEG 贴满整页（`/DCTDecode` 直接把 JPEG 塞进 PDF，不用重新编码）。
 *
 * 生成的是合法的 PDF 1.4：`%PDF-1.4` 头、对象表、xref、trailer 齐全，
 * 用任何浏览器或预览器都打得开。纯字节拼接，不依赖任何库 —— 与 MCP 侧
 * 「零依赖」的取向一致。
 */

/** 一页：JPEG 字节 + 像素尺寸 + dpi（用来换算 PDF 的 pt）。 */
export interface PdfPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
  dpi?: number;
}

/** 把字节按 latin1 转字符串（PDF 的对象结构是 ASCII，只有流是二进制）。 */
function ascii(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * 生成多页 PDF。
 * 每页尺寸 = 像素 / dpi * 72（pt），这样打印出来是原始物理尺寸。
 */
export function buildPdf(pages: PdfPage[]): Uint8Array {
  if (pages.length === 0) throw new Error("没有页面可导出");

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (data: string | Uint8Array): void => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };

  // 对象编号：1=Catalogue, 2=Pages, 3..=每页的 Page + Contents + Image
  const pageObjIds: number[] = [];
  const offsets: number[] = [];

  const total = pages.length;
  // 每页占 3 个对象：Page, Contents, Image
  let next = 3;
  const layout = pages.map((p) => {
    const pageId = next;
    const contentId = next + 1;
    const imageId = next + 2;
    next += 3;
    pageObjIds.push(pageId);
    return { pageId, contentId, imageId, page: p };
  });

  push("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

  const writeObj = (id: number, body: string, stream?: { data: Uint8Array; dict: string }): void => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\n`);
    if (stream) {
      push(`<< ${stream.dict} /Length ${stream.data.length} >>\nstream\n`);
      push(stream.data);
      push("\nendstream\n");
    }
    push("endobj\n");
  };

  writeObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  writeObj(
    2,
    `<< /Type /Pages /Count ${total} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );

  for (const item of layout) {
    const dpi = item.page.dpi && item.page.dpi > 1 ? item.page.dpi : 72;
    const wPt = (item.page.width / dpi) * 72;
    const hPt = (item.page.height / dpi) * 72;
    writeObj(
      item.pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${item.imageId} 0 R >> >> /Contents ${item.contentId} 0 R >>`,
    );
    const content = `q\n${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    writeObj(
      item.contentId,
      "",
      { data: new TextEncoder().encode(content), dict: "" },
    );
    writeObj(
      item.imageId,
      "",
      {
        data: item.page.jpeg,
        dict: `/Type /XObject /Subtype /Image /Width ${item.page.width} /Height ${item.page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      },
    );
  }

  const xrefStart = length;
  const maxId = next;
  let xref = `xref\n0 ${maxId}\n0000000000 65535 f \n`;
  for (let i = 1; i < maxId; i += 1) {
    const off = offsets[i] ?? 0;
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 调试用：把 PDF 头尾转成字符串看一眼（测试里断言结构用）。 */
export function pdfHead(bytes: Uint8Array): string {
  return ascii(bytes.slice(0, 8));
}

/** 找出 PDF 里所有 `/Type /Page` 的出现次数（不含 /Pages）。 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = ascii(bytes);
  return (text.match(/\/Type \/Page[^s]/g) ?? []).length;
}
