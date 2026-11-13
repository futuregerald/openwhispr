export const BOTTOM_BAR_HEIGHT_VARIABLE = "--note-bottom-bar-height";

export function publishBottomBarHeight(bar, ResizeObserverImpl = globalThis.ResizeObserver) {
  const host = bar?.parentElement;
  if (!host || typeof ResizeObserverImpl !== "function") return () => {};

  const publish = () => {
    host.style.setProperty(BOTTOM_BAR_HEIGHT_VARIABLE, `${bar.getBoundingClientRect().height}px`);
  };
  publish();
  const observer = new ResizeObserverImpl(publish);
  observer.observe(bar);

  return () => {
    observer.disconnect();
    host.style.removeProperty(BOTTOM_BAR_HEIGHT_VARIABLE);
  };
}
