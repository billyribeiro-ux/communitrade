import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { Coordinates, DrawingController, DrawingHit, Point } from "../../lib/drawings";

export interface DrawingInteractionOptions {
  readonly element: HTMLElement;
  readonly chart: IChartApi;
  readonly series: ISeriesApi<"Candlestick">;
  readonly controller: DrawingController;
  readonly getCoordinates: () => Coordinates;
  readonly hitTest: (point: Point, coordinates: Coordinates) => DrawingHit | null;
}

/** Installs the pointer/keyboard bridge and returns an idempotent disposer. */
export function attachDrawingInteraction(options: DrawingInteractionOptions): () => void {
  const { element, chart, controller, getCoordinates, hitTest } = options;
  let activePointer: number | null = null;
  let disposed = false;
  const originalTouchAction = element.style.touchAction;
  element.style.touchAction = "pan-y";

  const coords = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const mapper = getCoordinates();
    const plot = chart.paneSize(0);
    const outsidePlot = point.x < 0 || point.y < 0 || point.x > plot.width || point.y > plot.height;
    return { point, mapper, outsidePlot };
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (disposed || activePointer !== null || event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    const { point, mapper, outsidePlot } = coords(event);
    if (outsidePlot) return;
    const mobile = element.ownerDocument.defaultView?.matchMedia("(max-width: 700px)").matches ?? false;
    const tool = controller.getSnapshot().tool;
    if (mobile && tool !== "select" && tool !== "horizontal" && tool !== "text") return;
    if (!controller.pointerDown(point, mapper)) return;
    activePointer = event.pointerId;
    try { element.setPointerCapture(event.pointerId); } catch { /* Some synthetic/test targets do not implement capture. */ }
    consume(event);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (disposed) return;
    if (activePointer === event.pointerId) {
      const { point, mapper } = coords(event);
      controller.pointerMove(point, mapper);
      consume(event);
      return;
    }
    if (activePointer !== null) return;
    const snapshot = controller.getSnapshot();
    if (snapshot.tool !== "select") {
      element.style.cursor = "crosshair";
      return;
    }
    const { point, mapper, outsidePlot } = coords(event);
    if (outsidePlot) { element.style.cursor = "default"; return; }
    const hit = hitTest(point, mapper);
    element.style.cursor = hit?.part === "handle" ? "crosshair" : hit ? "move" : "default";
  };
  const release = (event: PointerEvent, cancel: boolean) => {
    if (activePointer !== event.pointerId) return;
    if (cancel) controller.cancel();
    else {
      const { point, mapper } = coords(event);
      controller.pointerUp(point, mapper);
    }
    activePointer = null;
    try { if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId); } catch { /* Ignore detached targets. */ }
    consume(event);
  };
  const onPointerUp = (event: PointerEvent) => release(event, false);
  const onPointerCancel = (event: PointerEvent) => release(event, true);
  const onLostPointerCapture = (event: PointerEvent) => {
    if (activePointer === event.pointerId) {
      controller.cancel();
      activePointer = null;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      controller.cancel();
      if (activePointer !== null) {
        const pointerId = activePointer;
        activePointer = null;
        try { if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId); } catch { /* Ignore detached targets. */ }
      }
      event.preventDefault();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && controller.getSnapshot().selectedId) {
      controller.removeSelected();
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "z") {
      if (event.shiftKey) controller.redo();
      else controller.undo();
      event.preventDefault();
    }
  };

  element.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  element.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  element.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  element.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });
  element.addEventListener("lostpointercapture", onLostPointerCapture, true);
  element.addEventListener("keydown", onKeyDown);

  return () => {
    if (disposed) return;
    disposed = true;
    if (activePointer !== null) {
      controller.cancel();
      try { if (element.hasPointerCapture(activePointer)) element.releasePointerCapture(activePointer); } catch { /* Ignore detached targets. */ }
      activePointer = null;
    }
    element.removeEventListener("pointerdown", onPointerDown, true);
    element.removeEventListener("pointermove", onPointerMove, true);
    element.removeEventListener("pointerup", onPointerUp, true);
    element.removeEventListener("pointercancel", onPointerCancel, true);
    element.removeEventListener("lostpointercapture", onLostPointerCapture, true);
    element.removeEventListener("keydown", onKeyDown);
    element.style.touchAction = originalTouchAction;
    element.style.cursor = "";
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}
