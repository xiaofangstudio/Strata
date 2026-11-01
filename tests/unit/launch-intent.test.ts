/**
 * 启动意图判定的纯逻辑。
 *
 * 只测不碰浏览器的那部分（扩展名判定、去引号、参数挑选）。
 * `readLaunchIntent` / `onExternalOpen` 要调内核命令，按项目约定不入单元测试。
 */
import { describe, expect, it } from "vitest";
import {
  OPENABLE_EXTENSIONS,
  isOpenablePath,
  pickLaunchPath,
  stripQuotes,
} from "../../src/core/launch";

describe("能直接打开的文件类型", () => {
  it("图片与 .strata 工程都在范围内", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"]) {
      expect(isOpenablePath(`D:/照片/测试.${ext}`)).toBe(true);
    }
    expect(isOpenablePath("D:/工程/未命名.strata")).toBe(true);
  });

  it("大小写不影响判定", () => {
    expect(isOpenablePath("D:/A/B.PNG")).toBe(true);
    expect(isOpenablePath("D:/A/B.Strata")).toBe(true);
  });

  it("不支持的类型一律拒绝", () => {
    for (const ext of ["txt", "exe", "docx", "mp4", "psd"]) {
      expect(isOpenablePath(`D:/文件/测试.${ext}`)).toBe(false);
    }
    expect(isOpenablePath("D:/文件/没有扩展名")).toBe(false);
  });

  it("清单里图片与工程都有，不缺项", () => {
    expect(OPENABLE_EXTENSIONS).toContain("png");
    expect(OPENABLE_EXTENSIONS).toContain("jpeg");
    expect(OPENABLE_EXTENSIONS).toContain("strata");
  });
});

describe("去引号", () => {
  it("成对双引号会被剥掉", () => {
    expect(stripQuotes('"D:/带 空格/图.png"')).toBe("D:/带 空格/图.png");
  });

  it("单边引号不动，免得把正常字符吃掉", () => {
    expect(stripQuotes('"D:/图.png')).toBe('"D:/图.png');
    expect(stripQuotes("D:/图.png")).toBe("D:/图.png");
  });
});

describe("从命令行参数里挑要打开的文件", () => {
  it("取第一个可打开的路径", () => {
    const hit = pickLaunchPath([
      "C:/Program Files/Strata/Strata.exe",
      "D:/照片/风景.jpg",
      "D:/照片/人像.png",
    ]);
    expect(hit).toBe("D:/照片/风景.jpg");
  });

  it("跳过开关参数", () => {
    expect(pickLaunchPath(["--verbose", "D:/照片/a.png"])).toBe("D:/照片/a.png");
    expect(pickLaunchPath(["-f", "--flag=1"])).toBeNull();
  });

  it("带引号的路径照样认", () => {
    expect(pickLaunchPath(['"D:/带 空格/图.png"'])).toBe("D:/带 空格/图.png");
  });

  it("裸单词不算路径，避免把开关的值误当文件", () => {
    expect(pickLaunchPath(["report", "notes"])).toBeNull();
  });

  it("扩展名不支持时不认", () => {
    expect(pickLaunchPath(["D:/文件/说明.txt"])).toBeNull();
  });

  it("没有参数就是主动启动", () => {
    expect(pickLaunchPath([])).toBeNull();
  });
});
