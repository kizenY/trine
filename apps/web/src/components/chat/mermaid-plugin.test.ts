/**
 * mermaid SVG 消毒（mermaid-plugin.ts 文件头的第 2 层）：插入页面前，图里任何能把浏览器
 * 带去外域的东西都得没了。对**最终字符串**断言不含攻击者域名，与 markdown-render.test.tsx 同一思路；
 * 同时确认正常图表要用的片段引用（marker、渐变、`<use href="#…">`）与样式不被误伤。
 */
import '@/lib/dom-test-env.ts';
import { describe, expect, test } from 'bun:test';
import { cleanElement, externalRefIn, sanitizeCss, sanitizeMermaidSvg } from './mermaid-plugin.ts';

const EVIL = 'evil.example';
const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="m1">${inner}</svg>`;

const PAYLOADS: ReadonlyArray<[name: string, inner: string]> = [
  ['image href', `<image href="https://${EVIL}/a.png"/>`],
  ['image xlink:href', `<image xlink:href="https://${EVIL}/a.png"/>`],
  ['image 协议相对', `<image href="//${EVIL}/a.png"/>`],
  ['image data:svg（内嵌 SVG 可再外连）', `<image href="data:image/svg+xml,<svg><image href='https://${EVIL}/x'/></svg>"/>`],
  ['use 外部 sprite', `<use href="https://${EVIL}/s.svg#x"/>`],
  ['feImage', `<filter id="f"><feImage href="https://${EVIL}/a.png"/></filter>`],
  ['a href', `<a href="https://${EVIL}/"><text>x</text></a>`],
  ['foreignObject img', `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://${EVIL}/a.png"></div></foreignObject>`],
  ['foreignObject img srcset', `<foreignObject><div><img srcset="https://${EVIL}/a.png 1x"></div></foreignObject>`],
  ['foreignObject picture/source', `<foreignObject><picture><source srcset="https://${EVIL}/a.png"><img></picture></foreignObject>`],
  ['foreignObject iframe', `<foreignObject><iframe src="https://${EVIL}/"></iframe></foreignObject>`],
  ['foreignObject link stylesheet', `<foreignObject><link rel="stylesheet" href="https://${EVIL}/a.css"></foreignObject>`],
  ['script', `<script>fetch("https://${EVIL}")</script>`],
  ['事件属性', `<rect onload="fetch('https://${EVIL}')"/>`],
  ['style 属性 url()', `<rect style="fill:url(https://${EVIL}/p.svg#g)"/>`],
  ['foreignObject 里 HTML style 元素', `<foreignObject><div><style>.x{background:url(https://${EVIL}/a.png)}</style></div></foreignObject>`],
  ['SMIL set 写回 href', `<a><set attributeName="href" to="https://${EVIL}/"/><text>x</text></a>`],
  ['SMIL animate', `<image><animate attributeName="href" values="https://${EVIL}/a.png"/></image>`],
];

describe('sanitizeMermaidSvg：外连载荷', () => {
  for (const [name, inner] of PAYLOADS) {
    test(name, () => {
      const out = sanitizeMermaidSvg(svg(inner));
      // 「CSS 转义」两条：删掉反斜杠后域名还在，但 url( 已被弄坏——断言的是不会发请求
      expect(out).not.toMatch(new RegExp(`(?:href|src|srcset)=["'][^"']*${EVIL}|url\\(\\s*["']?[^)#]*${EVIL}|@import|image-set\\(|<script|onload=|<iframe|<link|<source|<set|<animate`, 'i'));
    });
  }
});

describe('sanitizeMermaidSvg：正常图表不被误伤', () => {
  test('marker / 渐变 / use 的片段引用保留', () => {
    const out = sanitizeMermaidSvg(
      svg('<defs><marker id="arrow"><path d="M0 0"/></marker><linearGradient id="g"/></defs><path marker-end="url(#arrow)" fill="url(#g)"/><use href="#arrow"/>'),
    );
    expect(out).toContain('marker-end="url(#arrow)"');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('href="#arrow"');
  });

  test('文字与 class 保留', () => {
    const out = sanitizeMermaidSvg(svg('<g class="node"><rect style="fill:#eee;stroke:#333"/><text>开始</text></g>'));
    expect(out).toContain('style="fill:#eee;stroke:#333"');
    expect(out).toContain('<text>开始</text>');
  });

  test('内联位图保留', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeMermaidSvg(svg(`<image href="${png}"/>`))).toContain(png);
  });
});

/**
 * SVG 里的 `<style>`（mermaid 的主题 CSS、`%%{init: {themeCSS}}%%` 都落在这里）：happy-dom 的
 * HTML 解析器会把 SVG 内 `<style>` 的内容整个丢掉——字符串往返测不出任何东西（假绿），
 * 所以这里用 DOM API 直接建节点，测的是 cleanElement 对 `<style>` 的处理。真实浏览器的解析
 * 路径由手测覆盖（mermaid-plugin.ts 文件头）。
 */
describe('cleanElement：SVG <style>', () => {
  const STYLE_PAYLOADS: ReadonlyArray<[name: string, css: string]> = [
    ['@import url', `@import url("https://${EVIL}/a.css"); .x{fill:red}`],
    ['@import 字符串', `@import "https://${EVIL}/a.css";`],
    ['url()', `.x{background:url(https://${EVIL}/a.png)}`],
    ['url() 带引号与括号', `.x{background:url("https://${EVIL}/a)b.png")}`],
    ['url() 空白后引号', `.x{background:url( "https://${EVIL}/a.png")}`],
    ['@font-face', `@font-face{font-family:x;src:url(https://${EVIL}/f.woff)}`],
    ['image-set', `.x{background:image-set("https://${EVIL}/a.png" 1x)}`],
    ['-webkit-image-set', `.x{background:-webkit-image-set("https://${EVIL}/a.png" 1x)}`],
    ['CSS 转义 url', `.x{background:ur\\l(https://${EVIL}/a.png)}`],
    ['CSS 十六进制转义', `.x{background:\\75 rl(https://${EVIL}/a.png)}`],
    ['大写 URL(', `.x{background:URL(https://${EVIL}/a.png)}`],
  ];
  const NS = 'http://www.w3.org/2000/svg';
  const run = (css: string): string => {
    const root = document.createElementNS(NS, 'svg');
    const style = document.createElementNS(NS, 'style');
    style.textContent = css;
    root.appendChild(style);
    cleanElement(root);
    return root.querySelector('style')?.textContent ?? '';
  };
  for (const [name, css] of STYLE_PAYLOADS) {
    test(name, () => {
      // 域名可能还在（无效声明里的残骸），断言的是不再有能发请求的记号
      expect(run(css)).not.toMatch(/@import|url\s*\(\s*["']?[^#\s"']|image-set\s*\(/i);
    });
  }
  test('正常主题 CSS 原样保留', () => {
    const css = '#m1 .node rect{fill:#eee;stroke:#333} #m1 .edge{marker-end:url(#arrow)}';
    expect(run(css)).toBe(css);
  });
});

/** 渲染前的源码检查：图片节点渲染过程中就会请求（浏览器手测量到），产物消毒来不及 */
describe('externalRefIn：渲染前拒绝', () => {
  const BAD: ReadonlyArray<[name: string, src: string]> = [
    ['图片节点', `graph LR\n  Z@{ img: "https://${EVIL}/d.png", label: "x" }`],
    ['图片节点 无引号', `graph LR\n  Z@{ img: https://${EVIL}/d.png }`],
    ['图片节点 多行', `graph LR\n  Z@{\n    label: "x"\n    img: "//${EVIL}/d.png"\n  }`],
    ['图片节点 data:svg', `graph LR\n  Z@{ img: "data:image/svg+xml,<svg/>" }`],
    ['style url()', `graph LR\n  A\n  style A fill:url(https://${EVIL}/p.svg#g)`],
    ['classDef url() 转义', `graph LR\n  classDef c background:ur\\l(https://${EVIL}/a.png)`],
    ['@import', `graph LR\n  classDef c x;@import "https://${EVIL}/a.css"`],
  ];
  for (const [name, src] of BAD) test(name, () => expect(externalRefIn(src)).toBeDefined());

  test('正常图表放行（含块外的 "img:" 文字与 URL 文本）', () => {
    expect(externalRefIn('graph TD\n  A[开始] --> B{判断}\n  B -->|是| C')).toBeUndefined();
    expect(externalRefIn('sequenceDiagram\n  A->>B: img: upload https://example.com/x')).toBeUndefined();
    expect(externalRefIn('graph LR\n  Z@{ img: "data:image/png;base64,iVBORw0KGgo=", label: "x" }')).toBeUndefined();
    expect(externalRefIn('graph LR\n  A@{ shape: rect, label: "x" }')).toBeUndefined();
  });
});

describe('sanitizeCss', () => {
  test('片段 url 保留，外部 url 失效', () => {
    expect(sanitizeCss('a{fill:url(#g)} b{fill:url( "#h")}')).toBe('a{fill:url(#g)} b{fill:url( "#h")}');
    expect(sanitizeCss('a{background:url(x.png)}')).toBe('a{background:none(x.png)}');
  });
});
