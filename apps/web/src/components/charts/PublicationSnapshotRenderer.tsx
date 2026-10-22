"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, HistogramSeries, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { computeEMA, normalizeRenderBars } from "@/lib/chart-data";
import { beginSnapshotReadiness } from "@/lib/snapshot-readiness";
import { DrawingController, type Drawing } from "@/lib/drawings";
import { attachDrawingPrimitive, createSemanticTimeMapper } from "./drawing-primitive";
import type { PublicationRenderCandidate } from "@/lib/publication-render-candidate";
import styles from "./PublicationSnapshotRenderer.module.css";

declare global {
  interface Window { __capturePublicationSnapshot?: () => string }
}

const WIDTH = 1200;
const HEIGHT = 760;
const FALLBACK_THEME = {
  background: "#101820", panel: "#17212b", grid: "#293846", text: "#e6edf3",
  muted: "#a7b5c3", positive: "#43b581", negative: "#f06a70",
  ema: { 20: "#58a6ff", 50: "#f2cc60", 200: "#c297ff" },
};

function cssToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function chartTheme() {
  return {
    background: cssToken("--surface-card", FALLBACK_THEME.background),
    panel: cssToken("--surface-raised", FALLBACK_THEME.panel),
    grid: cssToken("--border-subtle", FALLBACK_THEME.grid),
    text: cssToken("--text-primary", FALLBACK_THEME.text),
    muted: cssToken("--text-secondary", FALLBACK_THEME.muted),
    positive: cssToken("--positive", FALLBACK_THEME.positive),
    negative: cssToken("--negative", FALLBACK_THEME.negative),
    ema: {
      20: cssToken("--chart-ema-20", FALLBACK_THEME.ema[20]),
      50: cssToken("--chart-ema-50", FALLBACK_THEME.ema[50]),
      200: cssToken("--chart-ema-200", FALLBACK_THEME.ema[200]),
    },
  };
}

function intervalCadence(interval: string): number {
  return interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : interval === "1h" ? 3600 : 86400;
}

function drawNotice(canvas: HTMLCanvasElement, chartImage: HTMLCanvasElement, candidate: PublicationRenderCandidate, theme: ReturnType<typeof chartTheme>): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Snapshot canvas is unavailable");
  context.fillStyle = theme.background;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.drawImage(chartImage, 0, 0, WIDTH, HEIGHT);
  context.fillStyle = theme.panel;
  context.fillRect(0, 0, WIDTH, 78);
  context.fillRect(0, HEIGHT - 76, WIDTH, 76);
  context.textBaseline = "alphabetic";
  context.fillStyle = theme.text;
  context.font = "600 25px system-ui, sans-serif";
  context.fillText(candidate.series.symbol, 28, 34);
  context.font = "500 18px system-ui, sans-serif";
  context.fillText(candidate.title, 28, 61, 820);
  context.textAlign = "right";
  context.fillStyle = theme.muted;
  context.font = "14px system-ui, sans-serif";
  context.fillText(`${candidate.series.venue} · ${candidate.series.currency} · ${candidate.chartState.interval} · ${candidate.chartState.timezone}`, WIDTH - 28, 34);
  context.fillText(`Source: ${candidate.series.provider} · ${candidate.series.providerReference}`, WIDTH - 28, 59);
  context.textAlign = "left";
  context.fillStyle = theme.text;
  context.font = "600 14px system-ui, sans-serif";
  const asOf = new Date(candidate.disclosures.asOf).toISOString().replace("T", " ").replace(".000Z", " UTC");
  context.fillText(`Source time ${asOf} · ${candidate.disclosures.delaySeconds}s delay`, 28, HEIGHT - 45);
  context.fillStyle = theme.muted;
  context.font = "12px system-ui, sans-serif";
  const labels = [
    candidate.disclosures.demo ? "Synthetic demo data" : "Source data shown as supplied",
    "Member reported · not provider verified",
    "Frozen publication snapshot · UTC",
  ];
  context.fillText(labels.join("   ·   "), 28, HEIGHT - 22, WIDTH - 56);
  context.textAlign = "right";
  context.fillText("Charting by TradingView Lightweight Charts", WIDTH - 28, HEIGHT - 45);
}

/** Frozen-only, non-interactive chart for trusted publication capture. */
export default function PublicationSnapshotRenderer({ candidate }: { candidate: PublicationRenderCandidate }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let chart: IChartApi | null = null;
    let candleSeries: ISeriesApi<"Candlestick"> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let controller: DrawingController | null = null;
    let primitive: ReturnType<typeof attachDrawingPrimitive> | null = null;
    let renderStage = "fonts";
    let theme = chartTheme();
    const times = candidate.bars.map((bar) => Date.parse(bar.time) / 1000);
    const cadence = intervalCadence(candidate.chartState.interval);
    const precision = Math.min(10, candidate.series.tickSize.split(".")[1]?.length ?? 0);
    const indicatorColors = new Map(candidate.chartState.indicators.map((indicator) => [indicator.period, indicator.color]));

    const init = async () => {
      element.dataset.publicationSnapshotStage = "fonts";
      await document.fonts.ready;
      if (disposed) return;
      theme = chartTheme();
      renderStage = "chart";
      element.dataset.publicationSnapshotStage = renderStage;
      chart = createChart(element, {
        width: WIDTH,
        height: HEIGHT,
        autoSize: false,
        layout: { background: { color: theme.background }, textColor: theme.text, attributionLogo: true, fontFamily: "system-ui, sans-serif" },
        grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
        rightPriceScale: { borderColor: theme.grid, scaleMargins: { top: 0.12, bottom: 0.18 } },
        timeScale: { borderColor: theme.grid, timeVisible: candidate.chartState.interval !== "1d", secondsVisible: false, rightOffset: 3 },
        localization: { locale: "en-US", priceFormatter: (price: number) => price.toFixed(precision) },
        crosshair: { mode: 0, vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } },
        handleScroll: false,
        handleScale: false,
      });
      chartRef.current = chart;
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: theme.positive, downColor: theme.negative,
        borderUpColor: theme.positive, borderDownColor: theme.negative,
        wickUpColor: theme.positive, wickDownColor: theme.negative,
        priceFormat: { type: "price", precision, minMove: Number(candidate.series.tickSize) || 0.01 },
      });
      candleSeries = candles;
      renderStage = "data";
      const volumes = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      const chartBars = normalizeRenderBars(candidate.bars.map((bar) => ({ ...bar, volume: bar.volume ?? "0" })) as Parameters<typeof normalizeRenderBars>[0]);
      candles.setData(chartBars.map((bar) => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      volumes.setData(chartBars.map((bar) => ({
        time: bar.time as UTCTimestamp,
        value: bar.volume, color: bar.close >= bar.open ? theme.positive : theme.negative,
      })));
      for (const indicator of candidate.chartState.indicators) {
        renderStage = "indicators";
        const series = chart.addSeries(LineSeries, {
          color: indicatorColors.get(indicator.period) ?? theme.ema[indicator.period as 20 | 50 | 200] ?? theme.ema[20],
          lineWidth: 2, title: `EMA ${indicator.period}`, priceLineVisible: false, lastValueVisible: false,
        });
        series.setData(computeEMA(chartBars, indicator.period)
          .map((point) => ({ time: point.time as Time, value: point.value })));
      }
      controller = new DrawingController(candidate.chartState.drawings as Drawing[]);
      controller.select(null);
      renderStage = "drawings";
      primitive = attachDrawingPrimitive(chart, candles, controller, times, precision, cadence);
      const viewport = candidate.chartState.viewport;
      renderStage = "viewport";
      if (viewport) {
        const mapper = createSemanticTimeMapper(times, cadence);
        const from = mapper.logicalAt(Date.parse(viewport.from) / 1000);
        const to = mapper.logicalAt(Date.parse(viewport.to) / 1000);
        if (from !== null && to !== null && from < to) chart.timeScale().setVisibleLogicalRange({ from, to });
        else chart.timeScale().fitContent();
      } else chart.timeScale().fitContent();
      renderStage = "resize";
      resizeObserver = new ResizeObserver(() => chart?.resize(WIDTH, HEIGHT));
      resizeObserver.observe(element);
      chart.resize(WIDTH, HEIGHT);
      renderStage = "paint";
      element.dataset.publicationSnapshotStage = renderStage;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!disposed) readiness.publish();
    };

    const capture = () => {
      if (!chart || disposed) throw new Error("SNAPSHOT_CANVAS_NOT_READY");
      let captureStage = "SNAPSHOT_CANVAS_SCREENSHOT_FAILED";
      try {
        const chartCanvas = chart.takeScreenshot(true, false);
        const composed = document.createElement("canvas");
        composed.width = WIDTH; composed.height = HEIGHT;
        captureStage = "SNAPSHOT_CANVAS_NOTICE_FAILED";
        drawNotice(composed, chartCanvas, candidate, theme);
        captureStage = "SNAPSHOT_CANVAS_ENCODING_FAILED";
        return composed.toDataURL("image/png").slice("data:image/png;base64,".length);
      } catch { throw new Error(captureStage); }
    };
    const readiness = beginSnapshotReadiness(element, window, capture);
    void init().catch(() => { if (!disposed) readiness.fail(renderStage); });
    return () => {
      disposed = true;
      readiness.dispose();
      resizeObserver?.disconnect();
      if (candleSeries && primitive) { try { candleSeries.detachPrimitive(primitive); } catch { /* chart removal still disposes it */ } }
      if (controller) controller.cancel();
      chart?.remove();
      chartRef.current = null;
    };
  }, [candidate]);

  return <div ref={host} aria-hidden="true" data-publication-snapshot-stage="hydrate" className={styles.host} />;
}
