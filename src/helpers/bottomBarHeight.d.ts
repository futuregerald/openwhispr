export const BOTTOM_BAR_HEIGHT_VARIABLE: string;

export function publishBottomBarHeight(
  bar: HTMLElement | null | undefined,
  ResizeObserverImpl?: typeof ResizeObserver
): () => void;
