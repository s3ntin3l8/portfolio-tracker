import "@testing-library/jest-dom/vitest";

// Radix UI primitives (e.g. DropdownMenu, Switch) call DOM APIs that jsdom doesn't implement.
// Stub the ones they touch so the portalled menus and form controls work under test.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
// @radix-ui/react-use-size uses ResizeObserver; jsdom doesn't ship it.
if (typeof globalThis.ResizeObserver === "undefined") {
  // The constructor takes a callback matching the DOM `ResizeObserverCallback`
  // type, even though this no-op stub ignores it. Without the explicit
  // signature, the implicit default constructor is no-arg — and the
  // CodeQL `js/superfluous-trailing-arguments` rule then reads every
  // `new ResizeObserver(callback)` call in any module loaded by jsdom
  // as "passing an unexpected argument to a no-arg constructor",
  // flagging a real false positive. Adding the `_callback?` parameter
  // (and the rest of the signature, using the same `ResizeObserverEntry[]`
  // type the real DOM type uses) silences it without affecting runtime
  // — the stub still no-ops on every method.
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void,
    ) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
// vaul (bottom-sheet drag-to-close) queries matchMedia on mount; jsdom doesn't implement it.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
