/**
 * 插件动作分派器 v0.1。
 *
 * 插件清单里的 command 只是「请求」，真正做什么全在这里：参数逐项校验，
 * 权限二次检查，然后调用宿主自己的引擎函数。没有 eval、没有动态 import、
 * 没有把字符串当代码执行 —— 第三方只能选宿主已经实现好的白名单能力。
 */
import { zh } from "../i18n";
import { activeLayer, type StrataDoc } from "./document";
import {
  checkActionPermission,
  type PluginMenuAction,
} from "./pluginHost";
import { ADJUST_DEFS, newAdjustState, type AdjustId } from "./layer";
import { addAdjustLayer, rasterizeSmartObject, resizeDocument } from "./layerOps";
import { flipDocument, rotateDocument } from "./transform";

export interface PluginRunDeps {
  /** 文件导出必须走宿主的系统保存框，不能由插件直接写路径。 */
  onExportPng: () => Promise<void>;
}

export interface PluginRunResult {
  /** 返回新文档表示需要一次真实历史提交；null 表示只读 / 导出类动作。 */
  doc: StrataDoc | null;
  /** 已本地化、可直接进 toast 的结果说明。 */
  message: string;
}

const MAX_DOC_DIM = 16384;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : Number.NaN;
}

function interpolate(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.replace(`{${key}}`, String(value));
  }
  return out;
}

/**
 * 执行一个清单动作。权限不够 / 参数不合法直接抛错，调用方转成错误提示；
 * 绝不「静默跳过」—— 那会让用户以为插件生效了。
 */
export async function runPluginAction(
  doc: StrataDoc,
  action: PluginMenuAction,
  permissions: readonly string[],
  deps: PluginRunDeps,
): Promise<PluginRunResult> {
  checkActionPermission(action, permissions);
  const params = action.params ?? {};

  switch (action.command) {
    case "document.info": {
      return {
        doc: null,
        message: interpolate(String(zh.plugin.info), {
          w: doc.width,
          h: doc.height,
          n: doc.layers.length,
        }),
      };
    }

    case "document.scale": {
      const raw = params.percent ?? params.scale;
      const percent = num(raw);
      if (!Number.isFinite(percent) || percent < 1 || percent > 1600) {
        throw new Error(String(zh.plugin.badScale));
      }
      const w = Math.max(1, Math.round((doc.width * percent) / 100));
      const h = Math.max(1, Math.round((doc.height * percent) / 100));
      if (w > MAX_DOC_DIM || h > MAX_DOC_DIM) {
        throw new Error(String(zh.plugin.badScale));
      }
      return {
        doc: resizeDocument(doc, w, h),
        message: interpolate(String(zh.plugin.scaled), { w, h }),
      };
    }

    case "document.addAdjustment": {
      const raw = params.kind ?? params.id;
      if (typeof raw !== "string" || !ADJUST_DEFS.some((d) => d.id === raw)) {
        throw new Error(String(zh.plugin.badAdjust));
      }
      const id = raw as AdjustId;
      const def = ADJUST_DEFS.find((d) => d.id === id)!;
      return {
        doc: addAdjustLayer(doc, newAdjustState(id)),
        message: interpolate(String(zh.plugin.adjustAdded), { name: def.label }),
      };
    }

    case "document.rotateHalf": {
      return { doc: rotateDocument(doc, 180), message: String(zh.plugin.rotated) };
    }

    case "document.flip": {
      const axis = params.axis;
      if (axis !== "h" && axis !== "v") throw new Error(String(zh.plugin.badAxis));
      return {
        doc: flipDocument(doc, axis),
        message: axis === "h" ? String(zh.plugin.flippedH) : String(zh.plugin.flippedV),
      };
    }

    case "document.rasterizeSmart": {
      const layer = activeLayer(doc);
      if (!layer || (!layer.smart && !layer.smartRaw)) {
        throw new Error(String(zh.plugin.noSmart));
      }
      return {
        doc: rasterizeSmartObject(doc),
        message: String(zh.plugin.rasterized),
      };
    }

    case "file.exportPng": {
      if (typeof deps.onExportPng !== "function") throw new Error(String(zh.plugin.noExport));
      await deps.onExportPng();
      return { doc: null, message: String(zh.plugin.exportedPng) };
    }

    default:
      throw new Error(String(zh.plugin.failed));
  }
}
