/**
 * Compile-time injected by `vite.config.ts` via `define`. Encodes the
 * short git sha + build timestamp so feedback diag can name the bundle
 * version triagers are looking at.
 */
declare const __CC_VERSION__: string;

// Side-effect CSS imports. TS 6 不再为 .css 等非 TS 资源默认提供
// ambient 类型 — bundler (vite) 处理实际 loading, 这里仅声明类型
// 让 tsc --noEmit 不报 TS2882。
declare module '*.css';

// React 19 把 `JSX` namespace 从 global 移到 `React.JSX`。项目内大量
// 文件用 `JSX.Element` 作返回类型, 这里加一个 global ambient alias
// 让旧写法继续 work, 避免逐文件 import。本文件没有 import/export 顶层
// 语句, 所以是 ambient script 而非 module, 顶层 namespace JSX 直接
// 加进 global namespace。
declare namespace JSX {
  type Element = import('react').JSX.Element;
  type ElementClass = import('react').JSX.ElementClass;
  type ElementAttributesProperty =
    import('react').JSX.ElementAttributesProperty;
  type ElementChildrenAttribute = import('react').JSX.ElementChildrenAttribute;
  type IntrinsicElements = import('react').JSX.IntrinsicElements;
  type IntrinsicAttributes = import('react').JSX.IntrinsicAttributes;
  type LibraryManagedAttributes<C, P> = import('react').JSX.LibraryManagedAttributes<
    C,
    P
  >;
}
