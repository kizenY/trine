/**
 * ```mermaid 代码块渲染成图（streamdown 的 diagram 插件）。
 *
 * ## 为什么不用 `@streamdown/mermaid`
 *
 * 官方插件在模块顶层 `import mermaid`，整个 mermaid（数 MB）会进首屏 bundle。这里同样实现
 * `DiagramPlugin` 接口，但 `render` 里才 `import('mermaid')`：没有 mermaid 代码块的页面不下载它。
 *
 * ## 零远端资源（与 Markdown.tsx 文件头 M4 / N1 同一条约束）
 *
 * mermaid 的图表源码来自 assistant 文本或工作区文件，都不可信。它产出的 SVG 被 streamdown 用
 * `dangerouslySetInnerHTML` 插进页面，**绕过了** urlTransform 与 rehype 管线。可能外连的入口：
 * - 节点标签里的 HTML（`<img src=…>`），以及新形状语法的 `img:` 图片节点；
 * - `%%{init: {"themeCSS": "@import url(…)"}}%%`：mermaid 的 sanitizeCss 只数大括号，不管 URL；
 * - `click` / 链接。
 *
 * 三层挡：
 * 0. 源码：`externalRefIn`——图片节点与样式里的 `url()` 在渲染过程中就会发请求，必须渲染前拒；
 * 1. 配置：`securityLevel: 'strict'`（禁 click 回调、标签过 DOMPurify）、`htmlLabels: false`，
 *    并把这些键与 themeCSS / fontFamily 列进 `secure`，图内 init 指令改不动；
 * 2. 产物：`sanitizeMermaidSvg` 在插入前把 SVG 过一遍——危险元素整个删，带 URL 的属性只留
 *    `#片段` 引用（以及图片的 `data:image/`），CSS 里的 `@import` / 非片段 `url()` / `image-set()` 抹掉。
 *    第 0、2 层不依赖 mermaid 的行为：0 管渲染过程中的请求，2 管插进页面的产物。
 *    单测见 `mermaid-plugin.test.ts`；浏览器手测（真实 mermaid + 载荷文档）量到零外连请求，
 *    加第 0 层之前量到过图片节点的实际 GET。
 */
import type { DiagramPlugin } from 'streamdown';

type MermaidConfig = Parameters<DiagramPlugin['getMermaid']>[0] & {};

/** 固定配置：图内 `%%{init}%%` 指令不能覆盖（列进 secure） */
const LOCKED: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  suppressErrorRendering: true,
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'fontFamily', 'altFontFamily'],
};

/**
 * 不该出现在图里的元素：能执行脚本、嵌入外部文档或媒体的；以及 SMIL 动画
 * （`<set attributeName="href" to="http://…">` 能在运行时把 URL 写回去）。
 */
const DROP_ELEMENTS = new Set([
  'script',
  'iframe',
  'frame',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'video',
  'audio',
  'source',
  'track',
  'picture',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'animate',
  'set',
  'animatemotion',
  'animatetransform',
  'discard',
  'template',
]);

/** 值是 URL 的属性（含 SVG 的 xlink:href） */
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'poster', 'background', 'data', 'ping', 'cite', 'longdesc', 'lowsrc', 'dynsrc']);

/** 只能是片段引用（`#id`）；图片元素额外允许内联的 data:image/ */
function allowedUrl(tag: string, value: string): boolean {
  const v = value.trim();
  if (v.startsWith('#')) return true;
  if ((tag === 'img' || tag === 'image' || tag === 'feimage') && /^data:image\//i.test(v) && !/^data:image\/svg/i.test(v)) return true;
  return false;
}

/**
 * CSS 里能发请求的写法：`@import`、`url(…)`（片段 `url(#id)` 是 SVG 渐变 / marker，保留）、
 * `image-set(…)`（不带 url() 也能加载）。不解析 CSS，只把这些记号**弄坏**：`url(` → `none(`
 * 之类的无效函数，浏览器丢弃整条声明，不会发请求。先删掉反斜杠——CSS 转义（`ur\l(`、`\75 rl(`）
 * 能拼出关键字，删掉后要么还原成明文被下面的规则抓到，要么变成无意义的字符。
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/\\/g, '')
    .replace(/@import/gi, '@blocked')
    .replace(/image-set\s*\(/gi, 'none(')
    .replace(/url\s*\((?!\s*['"]?\s*#)/gi, 'none(');
}

/** 原地消毒一棵已解析的树（导出给单测：happy-dom 解析不了 SVG 里的 `<style>`，单测直接建 DOM） */
export function cleanElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  if (DROP_ELEMENTS.has(tag)) {
    el.remove();
    return;
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) el.removeAttribute(attr.name);
    else if (URL_ATTRS.has(name) || name.endsWith(':href')) {
      if (!allowedUrl(tag, attr.value)) el.removeAttribute(attr.name);
    } else if (name === 'style') el.setAttribute(attr.name, sanitizeCss(attr.value));
  }
  if (tag === 'style') el.textContent = sanitizeCss(el.textContent ?? '');
  for (const child of Array.from(el.children)) cleanElement(child);
}

/**
 * 插入页面前的 SVG 消毒。用 `<template>` 解析：内容是惰性的（解析时不加载图片），
 * 解析规则与随后的 `innerHTML` 插入一致（HTML 解析器处理内联 SVG 与 foreignObject）。
 */
export function sanitizeMermaidSvg(svg: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;
  for (const child of Array.from(tpl.content.children)) cleanElement(child);
  return tpl.innerHTML;
}

/**
 * 渲染**之前**就得挡的：mermaid 渲染时在真实文档里布局，图片节点（`@{ img: "…" }`）会先
 * `new Image()` 加载图片量尺寸——产物消毒来不及（手测量到了实际请求）。样式语句
 * （`style A fill:url(…)`、`classDef`）也会在临时节点上生效一次。源码里出现这些就不渲染，
 * 交给出错组件显示源码。判定前先删反斜杠（CSS 转义能拼出 `url(`）。
 * 返回命中的原因；正常图表返回 undefined。
 */
export function externalRefIn(source: string): string | undefined {
  const s = source.replace(/\\/g, '');
  if (/url\s*\((?!\s*['"]?\s*#)/i.test(s)) return 'url()';
  if (/@import|image-set\s*\(/i.test(s)) return '@import / image-set()';
  // 图片只能写在节点的形状数据块 `@{ … }` 里；块外的 "img:" 是普通文字（时序图消息等）
  for (const block of s.matchAll(/@\{[^}]*\}?/g)) {
    for (const m of block[0].matchAll(/\bimg\s*:\s*(['"]?)([^'",}\s]*)/gi)) {
      if (!/^data:image\/(?!svg)/i.test(m[2] ?? '')) return '图片节点';
    }
  }
  return undefined;
}

type Mermaid = (typeof import('mermaid'))['default'];
let loading: Promise<Mermaid> | undefined;
function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  // 加载失败（离线、chunk 过期）别把失败缓存住：下次重试
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/** 渲染串行：mermaid.initialize 是全局的，并发的两张图不能互相改配置 */
let queue: Promise<unknown> = Promise.resolve();

export function createMermaidPlugin(): DiagramPlugin {
  let config: MermaidConfig = {};
  const instance = {
    initialize(next: MermaidConfig): void {
      config = next;
    },
    render(id: string, source: string): Promise<{ svg: string }> {
      const run = async (): Promise<{ svg: string }> => {
        const blocked = externalRefIn(source);
        if (blocked !== undefined) throw new Error(`图表引用了外部资源（${blocked}），为避免外连不渲染`);
        const mermaid = await loadMermaid();
        mermaid.initialize({ ...config, ...LOCKED } as Parameters<Mermaid['initialize']>[0]);
        const { svg } = await mermaid.render(id, source);
        return { svg: sanitizeMermaidSvg(svg) };
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid(next?: MermaidConfig) {
      if (next !== undefined) instance.initialize(next);
      return instance;
    },
  };
}

export const mermaid = createMermaidPlugin();
