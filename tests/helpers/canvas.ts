/**
 * 极简 DOM / Canvas 测试替身（test double）。
 *
 * 本项目刻意不引入 jsdom / happy-dom —— 为了守住「测试不依赖真实浏览器 API」
 * 的边界。但 `src/core/layerOps.ts` 这类模块虽是「旧文档 → 新文档」的纯函数，
 * 构造图层时仍会调用 `document.createElement("canvas")`；而 `src/core/layer.ts`
 * 与 `src/engine/filters.ts` 的 SVG 滤镜注册会碰 `createElementNS` /
 * `getElementById` / `document.body`。
 *
 * 因此这里提供一份**确定性的最小替身**：只记录调用与结构，不做任何真实光栅化
 * 与 SVG 解析。用它写的断言只验证**控制流与几何**（是否返回新引用、图层顺序、
 * 锚点偏移量、尺寸夹取、是否注册了滤镜），不验证任何像素结果 —— 像素正确性
 * 属于 Rust 合成内核与 e2e 的活。
 */

/** 记录一次 drawImage 调用的实参。 */
export type DrawCall = unknown[];

/* ------------------------------------------------------------------ Canvas */

/** 最小 2D 上下文替身。 */
export class StubContext2D {
  readonly canvas: StubCanvas;
  readonly drawImageCalls: DrawCall[] = [];
  readonly calls: string[] = [];
  /** 记录每次 arc 的圆心与半径 —— 矢量笔尖（亚像素小圆）的落点。 */
  readonly arcCalls: { x: number; y: number; r: number }[] = [];

  fillStyle = "";
  strokeStyle = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  filter = "none";
  imageSmoothingEnabled = false;
  imageSmoothingQuality = "low";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  miterLimit = 10;

  constructor(canvas: StubCanvas) {
    this.canvas = canvas;
  }

  private track(name: string) {
    this.calls.push(name);
  }

  setTransform(): void {
    this.track("setTransform");
  }
  save(): void {
    this.track("save");
  }
  restore(): void {
    this.track("restore");
  }
  translate(): void {
    this.track("translate");
  }
  rotate(): void {
    this.track("rotate");
  }
  scale(): void {
    this.track("scale");
  }
  clip(): void {
    this.track("clip");
  }
  rect(): void {
    this.track("rect");
  }
  clearRect(): void {
    this.track("clearRect");
  }
  fillRect(): void {
    this.track("fillRect");
  }
  beginPath(): void {
    this.track("beginPath");
  }
  closePath(): void {
    this.track("closePath");
  }
  moveTo(): void {
    this.track("moveTo");
  }
  lineTo(): void {
    this.track("lineTo");
  }
  ellipse(): void {
    this.track("ellipse");
  }
  /** 记录圆心与半径；画笔的矢量小笔尖走这条路径。 */
  arc(x: number, y: number, r: number): void {
    this.track("arc");
    this.arcCalls.push({ x, y, r });
  }
  /** 笔尖贴图 / 渐变都要它；替身只回一个能吞 addColorStop 的空壳。 */
  createRadialGradient(): { addColorStop: () => void } {
    this.track("createRadialGradient");
    return { addColorStop: () => {} };
  }
  createLinearGradient(): { addColorStop: () => void } {
    this.track("createLinearGradient");
    return { addColorStop: () => {} };
  }
  /** 纹理平铺：替身只回一个非空壳，`applyTextureMask` 便会走到 fillRect。 */
  createPattern(): object {
    this.track("createPattern");
    return {};
  }
  createImageData(width: number, height: number): {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  } {
    this.track("createImageData");
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }
  fill(): void {
    this.track("fill");
  }
  stroke(): void {
    this.track("stroke");
  }
  drawImage(...args: unknown[]): void {
    this.drawImageCalls.push(args);
  }
  getImageData(): { data: Uint8ClampedArray; width: number; height: number } {
    const { width, height } = this.canvas;
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }
  putImageData(): void {
    this.track("putImageData");
  }
}

/** 最小画布替身。 */
export class StubCanvas {
  width: number;
  height: number;
  __ctx: StubContext2D | null = null;

  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
  }

  getContext(kind: string): StubContext2D | null {
    if (kind !== "2d") return null;
    if (!this.__ctx) this.__ctx = new StubContext2D(this);
    return this.__ctx;
  }

  /** 最近一次绘制记录（测试断言锚点偏移用）。 */
  get drawImageCalls(): DrawCall[] {
    return this.__ctx?.drawImageCalls ?? [];
  }

  /** 记录到的矢量笔尖（arc）落点，用于验证笔迹是否连续。 */
  get arcCalls(): { x: number; y: number; r: number }[] {
    return this.__ctx?.arcCalls ?? [];
  }
}

/** 取出某张替身画布上记录的 drawImage 调用（缺省返回空数组）。 */
export function drawCalls(canvas: unknown): DrawCall[] {
  return (canvas as StubCanvas | null)?.drawImageCalls ?? [];
}

/* ------------------------------------------------------- 最小 SVG DOM 替身 */

/**
 * 最小元素替身 —— 只实现 `filters.ts` 注册流程真正用到的成员：
 * setAttribute / getAttribute / id / style.cssText / innerHTML /
 * appendChild / remove / children / isConnected。
 */
export class StubElement {
  readonly namespaceURI: string | null;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: StubElement[] = [];
  readonly style: { cssText: string } = { cssText: "" };
  innerHTML = "";
  parent: StubElement | null = null;
  isConnected = false;

  constructor(tagName: string, namespaceURI: string | null = null) {
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(value: string) {
    this.attributes.set("id", value);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: StubElement): StubElement {
    child.parent = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const p = this.parent;
    if (p) {
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
    }
    this.parent = null;
    this.isConnected = false;
  }

  /** 整棵子树的 tag 名（含自身），排查结构用。 */
  tree(): string[] {
    return [this.tagName, ...this.children.flatMap((c) => c.tree())];
  }
}

export interface DomStub {
  /** 安装替身后新建的所有画布，便于排查。 */
  readonly created: StubCanvas[];
  /** 替身里的 <body>，SVG 根节点会挂在它下面。 */
  readonly body: StubElement;
  /** 按 tag 名查找已创建的元素（递归自上而下）。 */
  findAll(tagName: string): StubElement[];
  /** 已注册的 SVG <filter> 元素（断言标记内容 / 数量用）。 */
  filters(): StubElement[];
  /** 卸载替身，恢复安装前的全局状态。 */
  restore(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 把 `globalThis.document` 换成最小替身（同时支持 canvas 与 SVG 注册）；
 * 返回句柄以便测试结束恢复。
 */
export function installDomStub(): DomStub {
  const created: StubCanvas[] = [];
  const elements: StubElement[] = [];
  const previous = (globalThis as Record<string, unknown>).document;

  const body = new StubElement("body", null);
  body.isConnected = true;

  const makeCanvas = (): StubCanvas => {
    const c = new StubCanvas(1, 1);
    created.push(c);
    return c;
  };

  const collect = (el: StubElement, tagName: string, out: StubElement[]): void => {
    if (el.tagName.toLowerCase() === tagName) out.push(el);
    for (const child of el.children) collect(child, tagName, out);
  };

  const findByTag = (tagName: string): StubElement[] => {
    const out: StubElement[] = [];
    collect(body, tagName.toLowerCase(), out);
    return out;
  };

  const findById = (id: string): StubElement | null => {
    const stack: StubElement[] = [body];
    while (stack.length) {
      const el = stack.pop() as StubElement;
      if (el.id === id) return el;
      stack.push(...el.children);
    }
    return null;
  };

  const doc = {
    body,
    createElement(tag: string): StubCanvas {
      if (tag !== "canvas") {
        throw new Error(`DOM 替身不支持 createElement("${tag}")`);
      }
      return makeCanvas();
    },
    createElementNS(ns: string, tag: string): StubElement {
      const el = new StubElement(tag, ns);
      elements.push(el);
      return el;
    },
    getElementById(id: string): StubElement | null {
      return findById(id);
    },
  };

  (globalThis as Record<string, unknown>).document = doc;

  return {
    created,
    body,
    findAll: findByTag,
    filters(): StubElement[] {
      return findByTag("filter").filter((el) => el.namespaceURI === SVG_NS);
    },
    restore(): void {
      (globalThis as Record<string, unknown>).document = previous;
    },
  };
}

/** 兼容旧名：只关心中途建出的画布时可直接用这个别名。 */
export const installCanvasStub = installDomStub;
