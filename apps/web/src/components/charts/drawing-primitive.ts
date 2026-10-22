import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { DrawingController, Drawing, Anchor, Coordinates, Point } from "../../lib/drawings";

export interface SemanticTimeMapper {
  epochAt(logical: number): number | null;
  logicalAt(epochSeconds: number): number | null;
}

export function subscribeSemanticViewport(
  chart: IChartApi,
  getTimes: () => readonly number[],
  onChange: (viewport: { from: string; to: string }) => void,
  shouldEmit: () => boolean = () => true,
  fallbackCadenceSeconds = 86400,
): () => void {
  const timeScale = chart.timeScale();
  const listener = () => {
    if (!shouldEmit()) return;
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const mapper = createSemanticTimeMapper(getTimes(), fallbackCadenceSeconds);
    const from = mapper.epochAt(range.from);
    const to = mapper.epochAt(range.to);
    if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return;
    onChange({ from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString() });
  };
  timeScale.subscribeVisibleLogicalRangeChange(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    timeScale.unsubscribeVisibleLogicalRangeChange(listener);
  };
}

/**
 * Maps timestamps through the chart's existing logical slots. Missing/closed
 * times are whitespace between real bars; times beyond history extrapolate
 * from the local median cadence. No data points are synthesized.
 */
export function createSemanticTimeMapper(times: readonly number[], fallbackCadenceSeconds = 86400): SemanticTimeMapper {
  const sorted = times.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const cadence = medianCadence(sorted, fallbackCadenceSeconds);
  const epochAt = (logical: number): number | null => {
    if (!sorted.length || !Number.isFinite(logical)) return null;
    if (logical <= 0) return sorted[0]! + logical * cadence;
    const last = sorted.length - 1;
    if (logical >= last) return sorted[last]! + (logical - last) * cadence;
    const low = Math.floor(logical);
    const part = logical - low;
    return sorted[low]! + (sorted[low + 1]! - sorted[low]!) * part;
  };
  const logicalAt = (epochSeconds: number): number | null => {
    if (!sorted.length || !Number.isFinite(epochSeconds)) return null;
    const first = sorted[0]!;
    if (epochSeconds <= first) return (epochSeconds - first) / cadence;
    const lastIndex = sorted.length - 1;
    const last = sorted[lastIndex]!;
    if (epochSeconds >= last) return lastIndex + (epochSeconds - last) / cadence;
    let lo = 0;
    let hi = lastIndex;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! <= epochSeconds) lo = mid;
      else hi = mid;
    }
    const left = sorted[lo]!;
    const right = sorted[hi]!;
    return lo + (epochSeconds - left) / (right - left);
  };
  return { epochAt, logicalAt };
}

function medianCadence(times: readonly number[], fallbackCadenceSeconds: number): number {
  if (times.length < 2) return Number.isFinite(fallbackCadenceSeconds) && fallbackCadenceSeconds > 0 ? fallbackCadenceSeconds : 86400;
  const diffs = times.slice(1).map((time, i) => time - times[i]!).filter((diff) => diff > 0 && Number.isFinite(diff));
  if (!diffs.length) return Number.isFinite(fallbackCadenceSeconds) && fallbackCadenceSeconds > 0 ? fallbackCadenceSeconds : 86400;
  diffs.sort((a, b) => a - b);
  // Ignore weekends, holidays and long outages when extrapolating the future.
  const short = diffs.filter((diff) => diff <= 7 * 86400);
  const candidates = short.length ? short : diffs;
  return candidates[Math.floor((candidates.length - 1) / 2)]!;
}

export function createDrawingCoordinates(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  times: readonly number[],
  priceDecimals: number,
  fallbackCadenceSeconds = 86400,
): Coordinates {
  const semantic = createSemanticTimeMapper(times, fallbackCadenceSeconds);
  const timeScale = chart.timeScale();
  return {
    toPoint(anchor: Anchor): Point | null {
      const epochSeconds = Date.parse(anchor.time) / 1000;
      const logical = semantic.logicalAt(epochSeconds);
      const x = logical === null ? null : timeScale.logicalToCoordinate(logical as Logical);
      const y = series.priceToCoordinate(Number(anchor.price));
      return x === null || x === undefined || y === null ? null : { x, y };
    },
    toAnchor(point: Point): Anchor | null {
      const logical = timeScale.coordinateToLogical(point.x);
      const epoch = logical === null ? null : semantic.epochAt(logical);
      const price = series.coordinateToPrice(point.y);
      if (epoch === null || price === null || !Number.isFinite(epoch) || !Number.isFinite(price)) return null;
      return { time: new Date(epoch * 1000).toISOString(), price: price.toFixed(priceDecimals) };
    },
  };
}

function setLineStyle(context: CanvasRenderingContext2D, style: Drawing["style"]): void {
  context.setLineDash(style.lineStyle === "dashed" ? [7, 5] : style.lineStyle === "dotted" ? [2, 4] : []);
  context.lineWidth = style.lineWidth;
  context.lineCap = style.lineStyle === "dotted" ? "round" : "butt";
}

function drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  if (!text) return;
  context.save();
  context.font = "12px system-ui, sans-serif";
  const width = context.measureText(text).width;
  context.globalAlpha = 0.92;
  context.fillStyle = "#101820";
  context.fillRect(x + 7, y - 13, width + 12, 22);
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, x + 13, y - 2);
  context.restore();
}

function drawDrawing(context: CanvasRenderingContext2D, drawing: Drawing, coordinates: Coordinates, selected: boolean, paneWidth: number): void {
  const points = drawing.anchors.map((anchor) => coordinates.toPoint(anchor));
  if (points.some((point) => point === null)) return;
  const a = points[0]!;
  const b = points[1] ?? a;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const { style } = drawing;

  context.save();
  context.strokeStyle = style.color;
  context.fillStyle = style.color;
  context.globalAlpha = 0.95;
  setLineStyle(context, style);

  if (["horizontal", "entry", "target", "invalidation"].includes(drawing.type)) {
    context.beginPath(); context.moveTo(0, a.y); context.lineTo(paneWidth, a.y); context.stroke();
    const label = drawing.text || (drawing.type === "entry" ? "Entry" : drawing.type === "target" ? "Target" : drawing.type === "invalidation" ? "Invalidation" : "");
    drawLabel(context, label, Math.max(0, paneWidth - 160), a.y, style.color);
  } else if (drawing.type === "trendline") {
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    drawLabel(context, drawing.text ?? "", b.x, b.y, style.color);
  } else if (drawing.type === "arrow") {
    context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 9 + style.lineWidth;
    context.beginPath(); context.moveTo(b.x, b.y);
    context.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    context.moveTo(b.x, b.y);
    context.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    context.stroke(); drawLabel(context, drawing.text ?? "", b.x, b.y, style.color);
  } else if (drawing.type === "rectangle") {
    context.globalAlpha = style.fillOpacity;
    context.fillRect(left, top, right - left, bottom - top);
    context.globalAlpha = 0.95;
    context.strokeRect(left, top, right - left, bottom - top);
    drawLabel(context, drawing.text ?? "", left, top, style.color);
  } else if (drawing.type === "text") {
    context.font = "14px system-ui, sans-serif";
    context.textBaseline = "top";
    context.fillText(drawing.text, a.x, a.y);
  }

  if (selected) {
    context.setLineDash([]);
    for (const point of points) {
      context.beginPath(); context.arc(point!.x, point!.y, 5, 0, Math.PI * 2);
      context.fillStyle = "#ffffff"; context.fill(); context.strokeStyle = style.color; context.lineWidth = 2; context.stroke();
    }
  }
  context.restore();
}

class DrawingPaneRenderer implements IPrimitivePaneRenderer {
  private readonly render: (context: CanvasRenderingContext2D) => void;
  constructor(render: (context: CanvasRenderingContext2D) => void) { this.render = render; }
  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]): void {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      context.save();
      context.scale(horizontalPixelRatio, verticalPixelRatio);
      this.render(context);
      context.restore();
    });
  }
}

/** Actual v5 series primitive; every final drawing glyph is canvas-rendered. */
export class DrawingPrimitive implements ISeriesPrimitive<Time> {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<"Candlestick">;
  private readonly controller: DrawingController;
  private readonly priceDecimals: number;
  private readonly fallbackCadenceSeconds: number;
  private attachedParams: SeriesAttachedParameter<Time> | null = null;
  private paneRenderer: DrawingPaneRenderer | null = null;
  private readonly paneView: IPrimitivePaneView;
  private readonly unsubscribe: () => void;
  private latestTimes: readonly number[];

  constructor(
    chart: IChartApi,
    series: ISeriesApi<"Candlestick">,
    controller: DrawingController,
    times: readonly number[],
    priceDecimals: number,
    fallbackCadenceSeconds = 86400,
  ) {
    this.chart = chart;
    this.series = series;
    this.controller = controller;
    this.priceDecimals = priceDecimals;
    this.fallbackCadenceSeconds = fallbackCadenceSeconds;
    this.latestTimes = times;
    this.paneView = { zOrder: () => "top", renderer: () => this.paneRenderer ?? null };
    this.unsubscribe = controller.subscribe(() => this.invalidate());
    this.refreshRenderer();
  }

  attached(parameter: SeriesAttachedParameter<Time>): void {
    this.attachedParams = parameter;
    this.invalidate();
  }

  detached(): void {
    this.attachedParams = null;
    this.unsubscribe();
    this.paneRenderer = null;
  }

  setTimes(times: readonly number[]): void {
    this.latestTimes = times;
    this.refreshRenderer();
    this.invalidate();
  }

  updateAllViews(): void { this.refreshRenderer(); }
  paneViews(): readonly IPrimitivePaneView[] { return [this.paneView]; }

  private invalidate(): void {
    this.refreshRenderer();
    this.attachedParams?.requestUpdate();
  }

  private refreshRenderer(): void {
    const snapshot = this.controller.getSnapshot();
    const coordinates = createDrawingCoordinates(this.chart, this.series, this.latestTimes, this.priceDecimals, this.fallbackCadenceSeconds);
    const drawings: readonly Drawing[] = snapshot.drawings;
    const preview = snapshot.preview;
    const selectedId = snapshot.selectedId;
    const paneWidth = this.chart.timeScale().width();
    this.paneRenderer = new DrawingPaneRenderer((context) => {
      for (const drawing of drawings) drawDrawing(context, drawing, coordinates, drawing.id === selectedId, paneWidth);
      if (preview) {
        const previewDrawing = { id: "preview", ...preview } as Drawing;
        drawDrawing(context, previewDrawing, coordinates, false, paneWidth);
      }
    });
  }
}

export function attachDrawingPrimitive(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  controller: DrawingController,
  times: readonly number[],
  priceDecimals: number,
  fallbackCadenceSeconds = 86400,
): DrawingPrimitive {
  const primitive = new DrawingPrimitive(chart, series, controller, times, priceDecimals, fallbackCadenceSeconds);
  series.attachPrimitive(primitive);
  return primitive;
}
