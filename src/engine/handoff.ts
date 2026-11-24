/**
 * 与 Groma 的交接（Strata → Groma，单向）。
 *
 * 只传 PNG 字节和文档名；找 Groma、落盘、启动都由 Rust 侧完成，
 * 前端不碰路径拼接，也不假装知道对方装在哪里。
 */
import { invoke } from "@tauri-apps/api/core";

export interface GromaHandoffResult {
  file: string;
  exe: string;
}

export async function sendImageToGroma(
  data: Uint8Array,
  name: string,
): Promise<GromaHandoffResult> {
  return invoke<GromaHandoffResult>("send_image_to_groma", {
    data: Array.from(data),
    name,
  });
}
