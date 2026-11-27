/**
 * 「打开一个本地文件 → 变成一份可编辑文档」。
 *
 * 这段逻辑原先写在开始页面里，只能由欢迎页触发。但「双击图片用 Strata 打开」
 * 走的是启动参数，那时欢迎页根本不该出现 —— 于是把解码过程抽出来，
 * 开始页面与启动流程共用同一条通路，两边的打开行为完全一致。
 *
 * 图片走位图解码，.strata 工程走工程解码；顺带把缩略图造好，
 * 交给调用方写进最近文件记录；打开位图时还会读嵌入 ICC 标到 doc.profile。
 */
import { fileStat, loadImage, makeThumbnail, readFileBytes, takeRawMeta } from "./image";
import { composeDoc } from "./compositor";
import { createSurface } from "./surface";
import { decodeProject, isStrataPath } from "./project";
import { readEmbeddedProfileId } from "./cms";
import { baseName, docFromBitmap, type StrataDoc } from "../core/document";
import { sourceBitDepth } from "../core/bitDepth";
import { extOf } from "./image";
import { defaultRawUiParams, uiToRawDevelop } from "../core/rawDevelopParams";

export interface OpenedFile {
  doc: StrataDoc;
  /** 缩略图 data URL；造不出来时缺省 */
  thumb?: string;
  /** 源文件体积（字节） */
  size?: number;
  /** 源文件最后修改时间（Unix 毫秒） */
  mtime?: number;
}

/**
 * 打开一个本地文件。
 *
 * 抛错时交给调用方决定怎么提示：开始页面显示在页面内的横幅里，
 * 启动流程显示在独占的启动失败屏上。
 */
export async function openFileToDoc(path: string): Promise<OpenedFile> {
  // 文件属性先取好（图片与工程通用），缩略图稍后按需生成。
  const stat = await fileStat(path);
  const meta = {
    size: stat.exists ? stat.size : undefined,
    mtime: stat.modified ?? undefined,
  };

  if (isStrataPath(path)) {
    const bytes = await readFileBytes(path);
    const decoded = await decodeProject(bytes);
    decoded.sourcePath = path;
    // 工程缩略图：把图层栈合成到一张离屏画布，再缩成 96×96 的方块。
    const surface = createSurface(decoded.width, decoded.height);
    composeDoc(decoded, surface);
    const preview = await createImageBitmap(surface);
    const thumb = await makeThumbnail(preview);
    preview.close();
    return { doc: decoded, thumb: thumb || undefined, ...meta };
  }

  const bitmap = await loadImage(path);
  const thumb = await makeThumbnail(bitmap);
  const doc = docFromBitmap(bitmap, baseName(path), path);
  // RAW 的可重复显影状态跟着文档走：真正从传感器显影过的图保留源路径、
  // 元数据与中性参数，Camera Raw 工作窗以后直接回炉线性链，不再二次压 8bit。
  const rawMeta = takeRawMeta(path);
  if (rawMeta?.source === "sensor") {
    doc.rawDevelop = {
      path,
      meta: rawMeta,
      params: uiToRawDevelop(defaultRawUiParams(), rawMeta),
      ui: defaultRawUiParams(),
    };
    doc.bitsPerChannel = 16;
  }
  // 位深探测：16bit TIFF / PNG 的源要如实标到文档上（bitsPerChannel = 16），
  // 显示像素是舍入后的 8bit，但来源位深不再静默丢失 —— 导出对话框据此默认
  // 走 TIFF 16bit，用户想保住精度有路可走。探测失败按 8，不猜。
  try {
    const ext = extOf(path);
    if (ext === "png" || ext === "tif" || ext === "tiff") {
      const bytes = await readFileBytes(path);
      doc.bitsPerChannel = sourceBitDepth(ext, bytes);
    }
  } catch {
    /* 读不到字节就保持 8，不打断打开流程 */
  }
  // 读嵌入 ICC 并标到文档上：开始页 / 双击启动 / BrowseDialog / DropletRunner
  // 共用这条路径，以前完全不读 ICC。统一走 cms.ts 的共用入口
  // readEmbeddedProfileId（真解析优先 + 猜标签兜底），与 EditorShell.openPath、
  // convertDocumentIcc 用同一套逻辑。没有嵌入 / 引擎不可用时不改 doc.profile。
  const embeddedId = await readEmbeddedProfileId(path);
  if (embeddedId) doc.profile = embeddedId;
  return { doc, thumb: thumb || undefined, ...meta };
}
