import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import {
  NOTES_LIST_DEFAULT_WIDTH,
  NOTES_LIST_MIN_WIDTH,
  clampNotesListWidth,
  notesListMaxWidth,
  parseStoredNotesListWidth,
} from "../helpers/notesListWidth";

const STORAGE_KEY = "notesListWidth";
const KEYBOARD_STEP_PX = 16;

function readStoredWidth(): number {
  try {
    return parseStoredNotesListWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return NOTES_LIST_DEFAULT_WIDTH;
  }
}

function storeWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    return;
  }
}

export function useNotesListWidth({ enabled }: { enabled: boolean }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [storedWidth, setStoredWidth] = useState(readStoredWidth);
  const [rootWidth, setRootWidth] = useState<number | undefined>(undefined);
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    moved: boolean;
    lastWidth: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!root) return;
    setRootWidth(root.getBoundingClientRect().width);
  }, [root]);

  useEffect(() => {
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      setRootWidth(entries[0]?.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [root]);

  const width = clampNotesListWidth(storedWidth, rootWidth);

  const commit = useCallback(
    (next: number) => {
      const clamped = clampNotesListWidth(next, rootWidth);
      setStoredWidth(clamped);
      storeWidth(clamped);
    },
    [rootWidth]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setIsResizing(false);
    if (drag.moved) storeWidth(drag.lastWidth);
  }, []);

  useEffect(() => {
    if (!enabled) endDrag();
  }, [enabled, endDrag]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        startX: event.clientX,
        startWidth: width,
        moved: false,
        lastWidth: width,
      };
      setIsResizing(true);
    },
    [width]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampNotesListWidth(drag.startWidth + event.clientX - drag.startX, rootWidth);
      drag.moved = true;
      drag.lastWidth = next;
      setStoredWidth(next);
    },
    [rootWidth]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commit(width - KEYBOARD_STEP_PX);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commit(width + KEYBOARD_STEP_PX);
      } else if (event.key === "Home") {
        event.preventDefault();
        commit(NOTES_LIST_DEFAULT_WIDTH);
      }
    },
    [commit, width]
  );

  const onDoubleClick = useCallback(() => commit(NOTES_LIST_DEFAULT_WIDTH), [commit]);

  const handleProps = {
    role: "separator",
    "aria-orientation": "vertical" as const,
    "aria-valuenow": width,
    "aria-valuemin": NOTES_LIST_MIN_WIDTH,
    "aria-valuemax": notesListMaxWidth(rootWidth),
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown,
    onDoubleClick,
  };

  return { rootRef: setRoot, width, isResizing, handleProps };
}
