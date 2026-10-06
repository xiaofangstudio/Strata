/**
 * 一份打开的文档。
 *
 * M0 阶段只承载「一张位图 + 尺寸」，不做图层。M1 起会扩展为
 * 图层栈 + 蒙版 + 调整层，因此这里从一开始就用对象而不是裸图。
 */
export interface StrataDoc {
  /** 文档唯一标识 */
  id: string;
  /** 文档名（标题栏 / 最近文件展示用） */
  name: string;
  /** 画布宽度（像素） */
  width: number;
  /** 画布高度（像素） */
  height: number;
  /** 已解码的位图，直接交给 canvas 绘制 */
  bitmap: ImageBitmap;
  /** 源文件路径；新建画布时为 undefined */
  sourcePath?: string;
}

let seq = 0;

/** 生成一个进程内唯一的文档 id。 */
export function nextDocId(): string {
  seq += 1;
  return `doc-${Date.now().toString(36)}-${seq}`;
}

/** 从文件路径中取出不含扩展名的文件名。 */
export function baseName(path: string): string {
  const seg = path.split(/[\\/]/).pop() ?? path;
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(0, dot) : seg;
}
