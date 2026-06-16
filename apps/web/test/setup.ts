import "@testing-library/jest-dom/vitest";

// Radix UI primitives (e.g. DropdownMenu) call DOM APIs that jsdom doesn't implement.
// Stub the ones they touch so the portalled menus open under test.
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
