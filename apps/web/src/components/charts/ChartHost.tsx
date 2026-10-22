"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowsOutSimple, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  TickMarkType,
  type Time,
} from "lightweight-charts";
import type { components } from "@trading/contracts";
import { computeEMA, formatChartTime, normalizeRenderBars } from "@/lib/chart-data";
import { hitTestDrawings, type DrawingController } from "@/lib/drawings";
import { formatCompactTimeTick, initialLogicalRange, initializeChartResources, mountChartLifecycle, subscribeChartCrosshair, type ChartRenderer } from "./chart-runtime";
import { attachDrawingPrimitive, createDrawingCoordinates, createSemanticTimeMapper, subscribeSemanticViewport, type DrawingPrimitive } from "./drawing-primitive";
import { attachDrawingInteraction } from "./drawing-interaction";
import styles from "./ChartHost.module.css";

type Interval = "1m" | "5m" | "15m" | "1h" | "1d";
type Indicator = 20 | 50 | 200;
type Bar = components["schemas"]["Bar"];
type RenderData = ReturnType<typeof normalizeRenderBars>;

export interface ChartHostProps {
  bars: readonly Bar[];
  interval: Interval;
  timezone: string;
  tickSize: string;
  indicators: readonly Indicator[];
  label: string;
  onError?: (message: string) => void;
  drawingController?: DrawingController;
  drawingEditable?: boolean;
  indicatorColors?: Partial<Record<Indicator, string>>;
  initialViewport?: { from: string; to: string };
  onViewportChange?: (viewport: { from: string; to: string }) => void;
}

const decimalPlaces = (tickSize: string) => {
  const decimals = tickSize.split(".")[1]?.length ?? 0;
  return Math.min(decimals, 10);
};

function cssToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function chartThemeValues() {
  const dark = getComputedStyle(document.documentElement).colorScheme !== "light";
  return {
    dark,
    background: cssToken("--surface-card", dark ? "#12161C" : "#FFFFFF"),
    text: cssToken("--text-secondary", dark ? "#A8B3C2" : "#526070"),
    grid: cssToken("--border-subtle", dark ? "#334155" : "#CBD5E1"),
    positive: cssToken("--positive", dark ? "#6ED6A4" : "#166534"),
    negative: cssToken("--negative", dark ? "#FF9E9E" : "#991B1B"),
    ema20: cssToken("--chart-ema-20", dark ? "#8AB4FF" : "#174CD3"),
    ema50: cssToken("--chart-ema-50", dark ? "#F5C96A" : "#854D0E"),
    ema200: cssToken("--chart-ema-200", dark ? "#A8B3C2" : "#526070"),
  };
}

function chartTheme() {
  return JSON.stringify(chartThemeValues());
}

function isDaily(interval: Interval) {
  return interval === "1d";
}

function intervalCadenceSeconds(interval: Interval): number {
  return interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : interval === "1h" ? 3600 : 86400;
}

function exactBarText(bar: Bar, timezone: string, daily: boolean): string {
  return `${formatChartTime(Date.parse(bar.time) / 1000, timezone, daily)} · O ${bar.open} · H ${bar.high} · L ${bar.low} · C ${bar.close} · Vol ${bar.volume}`;
}

export function ChartHost({ bars, interval, timezone, tickSize, indicators, label, onError, drawingController, drawingEditable = true, indicatorColors, initialViewport, onViewportChange }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const readoutRef = useRef<HTMLParagraphElement>(null);
  const lastInspectedRef = useRef<string | null>(null);
  const viewportRef = useRef<{ interval: Interval; range: { from: number; to: number } } | null>(null);
  const lifecycleRef = useRef<ReturnType<typeof mountChartLifecycle<RenderData>> | null>(null);
  const appliedDataRef = useRef<RenderData | null>(null);
  const drawingPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const emaSeriesRef = useRef<Map<Indicator, ISeriesApi<"Line">>>(new Map());
  const onViewportChangeRef = useRef(onViewportChange);
  const initialViewportRef = useRef(initialViewport);
  const indicatorColorsRef = useRef(indicatorColors);
  onViewportChangeRef.current = onViewportChange;
  initialViewportRef.current = initialViewport;
  indicatorColorsRef.current = indicatorColors;
  const indicatorColorsKey = [20, 50, 200].map((period) => indicatorColors?.[period as Indicator] ?? "").join(",");
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => {
    try {
      return { bars: normalizeRenderBars(bars), error: null as string | null };
    } catch (cause) {
      return { bars: [] as RenderData, error: cause instanceof Error ? cause.message : "Chart data is invalid." };
    }
  }, [bars]);
  const renderBars = normalized.bars;
  const data = useMemo(() => renderBars, [renderBars]);
  const indicatorKey = indicators.join(",");
  const activeIndicators = useMemo(() => [...new Set(indicators)], [indicatorKey]);

  const reportError = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "The chart could not be rendered.";
    setError(message);
    onError?.(message);
  }, [onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (normalized.error) {
      reportError(new Error(normalized.error));
      return;
    }
    setError(null);

    let chart: IChartApi | null = null;
    let candleSeries: ISeriesApi<"Candlestick"> | null = null;
    let volumeSeries: ISeriesApi<"Histogram"> | null = null;
    const emaSeries = new Map<Indicator, ISeriesApi<"Line">>();
    let disposeChartResources: (() => void) | null = null;
    let latestData = data;
    let barsByTime = new Map<number, Bar>();
    let initialRangeApplied = false;
    let suppressViewportCallback = false;
    let lastViewportNotified: string | null = null;
    const pricePrecision = decimalPlaces(tickSize);
    const themedIndicatorColor = (period: Indicator, theme: ReturnType<typeof chartThemeValues>) => {
      const override = indicatorColorsRef.current?.[period];
      if (typeof override === "string" && /^#[0-9a-fA-F]{6}$/.test(override)) return override;
      return period === 20 ? theme.ema20 : period === 50 ? theme.ema50 : theme.ema200;
    };

    const rendererFactory = (): ChartRenderer<RenderData> => {
      try {
        const theme = chartThemeValues();
        const created = initializeChartResources(
          () => createChart(container, {
          autoSize: false,
          width: container.clientWidth,
          height: Math.max(container.clientHeight, 260),
          layout: { background: { color: theme.background }, textColor: theme.text, attributionLogo: true },
          grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
          rightPriceScale: { borderColor: theme.grid, scaleMargins: { top: 0.08, bottom: 0.22 } },
          timeScale: {
            borderColor: theme.grid,
            timeVisible: !isDaily(interval),
            secondsVisible: false,
            rightOffset: 6,
            tickMarkFormatter: (time: Time, kind: TickMarkType) => {
              const epoch = typeof time === "number" ? time : typeof time === "object"
                ? Date.UTC(time.year, time.month - 1, time.day) / 1000
                : Date.parse(time) / 1000;
              const labelKind = kind === TickMarkType.Year ? "year"
                : kind === TickMarkType.Month ? "month"
                  : kind === TickMarkType.DayOfMonth ? "day"
                    : kind === TickMarkType.TimeWithSeconds ? "time-seconds" : "time";
              return formatCompactTimeTick(epoch, timezone, labelKind);
            },
          },
          localization: {
            priceFormatter: (value: number) => value.toFixed(pricePrecision),
            timeFormatter: (time: Time) => typeof time === "number" ? formatChartTime(time, timezone, isDaily(interval)) : String(time),
          },
          crosshair: { mode: 0 },
          }),
          (instance, registerCleanup) => {
            chart = instance;
            chartRef.current = instance;
            candleSeries = instance.addSeries(CandlestickSeries, {
          upColor: cssToken("--positive", "#6ED6A4"),
          downColor: cssToken("--negative", "#FF9E9E"),
          borderUpColor: cssToken("--positive", "#6ED6A4"),
          borderDownColor: cssToken("--negative", "#FF9E9E"),
          wickUpColor: cssToken("--positive", "#6ED6A4"),
          wickDownColor: cssToken("--negative", "#FF9E9E"),
          priceFormat: { type: "price", precision: pricePrecision, minMove: Number(tickSize) || 0.01 },
            });
            volumeSeries = instance.addSeries(HistogramSeries, {
          priceScaleId: "volume",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
            });
            instance.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

            for (const indicator of activeIndicators) {
              emaSeries.set(indicator, instance.addSeries(LineSeries, {
            color: themedIndicatorColor(indicator, theme),
            lineWidth: 2,
            title: `EMA ${indicator}`,
            priceLineVisible: false,
            lastValueVisible: false,
              }));
            }
            emaSeriesRef.current = emaSeries;

            const crosshairListener = (param: Parameters<IChartApi["subscribeCrosshairMove"]>[0] extends (arg: infer P) => void ? P : never) => {
          if (param.time === undefined) {
            if (readoutRef.current) readoutRef.current.textContent = lastInspectedRef.current
              ? `${lastInspectedRef.current} · Pointer left chart; last inspected candle shown.`
              : "Pointer left chart. Focus the chart or use the chart data table to inspect values.";
            return;
          }
          const epoch = typeof param.time === "number" ? param.time : Date.parse(String(param.time)) / 1000;
          const sourceBar = barsByTime.get(Math.floor(epoch));
          if (!sourceBar) return;
          const text = exactBarText(sourceBar, timezone, isDaily(interval));
          lastInspectedRef.current = text;
          if (readoutRef.current && readoutRef.current.textContent !== text) readoutRef.current.textContent = text;
            };
            registerCleanup(subscribeChartCrosshair(instance, crosshairListener));
            if (drawingController) {
              const primitive = attachDrawingPrimitive(instance, candleSeries, drawingController, latestData.map((bar) => bar.time), pricePrecision, intervalCadenceSeconds(interval));
              drawingPrimitiveRef.current = primitive;
              registerCleanup(() => {
                candleSeries?.detachPrimitive(primitive);
                drawingPrimitiveRef.current = null;
              });
              if (drawingEditable) {
                registerCleanup(attachDrawingInteraction({
                  element: container,
                  chart: instance,
                  series: candleSeries,
                  controller: drawingController,
                  getCoordinates: () => createDrawingCoordinates(instance, candleSeries!, latestData.map((bar) => bar.time), pricePrecision, intervalCadenceSeconds(interval)),
                  hitTest: (point, coordinates) => hitTestDrawings(drawingController.getSnapshot().drawings, point, coordinates),
                }));
              }
            }
            registerCleanup(subscribeSemanticViewport(
              instance,
              () => latestData.map((bar) => bar.time),
              (viewport) => {
                const key = `${viewport.from}|${viewport.to}`;
                if (key === lastViewportNotified) return;
                lastViewportNotified = key;
                onViewportChangeRef.current?.(viewport);
              },
              () => !suppressViewportCallback && initialRangeApplied && latestData.length > 0,
              intervalCadenceSeconds(interval),
            ));
          },
          (instance) => instance.remove(),
        );
        chart = created.chart;
        chartRef.current = created.chart;
        disposeChartResources = created.dispose;
      } catch (cause) {
        chartRef.current = null;
        chart = null;
        throw cause;
      }

      const applyData = (next: RenderData) => {
        latestData = next;
        barsByTime = new Map(next.map((bar) => [bar.time, bar.original]));
        lastInspectedRef.current = null;
        if (!chart || !candleSeries || !volumeSeries) return;
        suppressViewportCallback = true;
        try {
          candleSeries.setData(next.map((bar) => ({ time: bar.time as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
          volumeSeries.setData(next.map((bar) => ({
            time: bar.time as Time,
            value: bar.volume,
            color: bar.close >= bar.open ? cssToken("--positive", "#6ED6A4") : cssToken("--negative", "#FF9E9E"),
          })));
          for (const [period, series] of emaSeries) {
            series.setData(computeEMA(next, period).map((point) => ({ time: point.time as Time, value: point.value })));
          }
          if (!initialRangeApplied && next.length > 0) {
            const savedViewport = initialViewportRef.current;
            let range: { from: number; to: number } | null = null;
            if (savedViewport) {
              const mapper = createSemanticTimeMapper(next.map((bar) => bar.time), intervalCadenceSeconds(interval));
              const from = mapper.logicalAt(Date.parse(savedViewport.from) / 1000);
              const to = mapper.logicalAt(Date.parse(savedViewport.to) / 1000);
              if (from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to) && from < to) range = { from, to };
            }
            range ??= initialLogicalRange(next.length, interval, viewportRef.current);
            if (range) chart.timeScale().setVisibleLogicalRange(range);
            initialRangeApplied = true;
            viewportRef.current = null;
          }
          const currentRange = chart.timeScale().getVisibleLogicalRange();
          if (currentRange) {
            const mapper = createSemanticTimeMapper(next.map((bar) => bar.time), intervalCadenceSeconds(interval));
            const from = mapper.epochAt(currentRange.from);
            const to = mapper.epochAt(currentRange.to);
            if (from !== null && to !== null) {
              lastViewportNotified = `${new Date(from * 1000).toISOString()}|${new Date(to * 1000).toISOString()}`;
            }
          }
        } finally {
          suppressViewportCallback = false;
        }
        drawingPrimitiveRef.current?.setTimes(next.map((bar) => bar.time));
      };

      return {
        setData: applyData,
        setTheme: (serialized) => {
          if (!chart) return;
          const theme = JSON.parse(serialized) as { dark: boolean; background: string; text: string; grid: string; positive: string; negative: string; ema20: string; ema50: string; ema200: string };
          suppressViewportCallback = true;
          try {
            chart.applyOptions({
              layout: { background: { color: theme.background }, textColor: theme.text },
              grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
              rightPriceScale: { borderColor: theme.grid },
              timeScale: { borderColor: theme.grid },
            });
            candleSeries?.applyOptions({ upColor: theme.positive, borderUpColor: theme.positive, wickUpColor: theme.positive, downColor: theme.negative, borderDownColor: theme.negative, wickDownColor: theme.negative });
            volumeSeries?.setData(latestData.map((bar) => ({ time: bar.time as Time, value: bar.volume, color: bar.close >= bar.open ? theme.positive : theme.negative })));
            for (const [period, series] of emaSeries) series.applyOptions({ color: themedIndicatorColor(period, theme) });
          } finally {
            suppressViewportCallback = false;
          }
        },
        resize: () => {
          if (!chart) return;
          suppressViewportCallback = true;
          try {
            chart.resize(container.clientWidth, Math.max(container.clientHeight, 260));
            const range = chart.timeScale().getVisibleLogicalRange();
            if (range) {
              const mapper = createSemanticTimeMapper(latestData.map((bar) => bar.time), intervalCadenceSeconds(interval));
              const from = mapper.epochAt(range.from);
              const to = mapper.epochAt(range.to);
              if (from !== null && to !== null) {
                lastViewportNotified = `${new Date(from * 1000).toISOString()}|${new Date(to * 1000).toISOString()}`;
              }
            }
          } finally {
            suppressViewportCallback = false;
          }
        },
        dispose: () => {
          if (!chart) return;
          const range = chart.timeScale().getVisibleLogicalRange();
          if (range) viewportRef.current = { interval, range };
          try {
            disposeChartResources?.();
          } finally {
            disposeChartResources = null;
            chart = null;
            chartRef.current = null;
            candleSeries = null;
            volumeSeries = null;
            emaSeries.clear();
            emaSeriesRef.current = new Map();
          }
        },
      };
    };

    try {
      lifecycleRef.current = mountChartLifecycle({
        container,
        data,
        createRenderer: rendererFactory,
        readTheme: chartTheme,
        createResizeObserver: (callback) => new ResizeObserver(callback),
        createMutationObserver: (callback) => new MutationObserver(callback),
        mediaQuery: window.matchMedia("(prefers-color-scheme: light)"),
      });
      appliedDataRef.current = data;
    } catch (cause) {
      reportError(cause);
    }
    return () => {
      lifecycleRef.current?.dispose();
      lifecycleRef.current = null;
      appliedDataRef.current = null;
    };
    // A single chart instance belongs to one component mount. Data is applied by the following effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, timezone, tickSize, indicatorKey, normalized.error, reportError, drawingController, drawingEditable]);

  useEffect(() => {
    if (appliedDataRef.current === data) return;
    try {
      lifecycleRef.current?.update(data);
      appliedDataRef.current = data;
    } catch (cause) {
      lifecycleRef.current?.dispose();
      lifecycleRef.current = null;
      appliedDataRef.current = null;
      reportError(cause);
    }
  }, [data, reportError]);

  useEffect(() => {
    const theme = chartThemeValues();
    for (const [period, series] of emaSeriesRef.current) {
      const override = indicatorColorsRef.current?.[period];
      const color = typeof override === "string" && /^#[0-9a-fA-F]{6}$/.test(override)
        ? override
        : period === 20 ? theme.ema20 : period === 50 ? theme.ema50 : theme.ema200;
      series.applyOptions({ color });
    }
  }, [indicatorColorsKey]);

  const changeRange = useCallback((mode: "left" | "right" | "zoom-in" | "zoom-out" | "fit") => {
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (mode === "fit") { timeScale.fitContent(); return; }
    if (!range) return;
    const width = range.to - range.from;
    if (mode === "left" || mode === "right") {
      const delta = Math.max(2, width * 0.15) * (mode === "left" ? -1 : 1);
      timeScale.setVisibleLogicalRange({ from: range.from + delta, to: range.to + delta });
      return;
    }
    const factor = mode === "zoom-in" ? 0.8 : 1.25;
    const nextWidth = Math.max(2, width * factor);
    const mid = (range.from + range.to) / 2;
    timeScale.setVisibleLogicalRange({ from: mid - nextWidth / 2, to: mid + nextWidth / 2 });
  }, []);

  const onChartKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const actions: Record<string, Parameters<typeof changeRange>[0]> = {
      ArrowLeft: "left", ArrowRight: "right", "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", Home: "fit",
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    changeRange(action);
  };

  const latestBar = renderBars[renderBars.length - 1]?.original;

  return (
    <section className={styles.host} aria-label={`${label} chart`}>
      <div className={styles.toolbar} aria-label="Chart controls">
        <button type="button" onClick={() => changeRange("left")} aria-label="Pan chart left"><ArrowLeft size={18} aria-hidden /></button>
        <button type="button" onClick={() => changeRange("right")} aria-label="Pan chart right"><ArrowRight size={18} aria-hidden /></button>
        <button type="button" onClick={() => changeRange("zoom-in")} aria-label="Zoom in"><MagnifyingGlassPlus size={18} aria-hidden /></button>
        <button type="button" onClick={() => changeRange("zoom-out")} aria-label="Zoom out"><MagnifyingGlassMinus size={18} aria-hidden /></button>
        <button type="button" onClick={() => changeRange("fit")} aria-label="Fit all data"><ArrowsOutSimple size={18} aria-hidden /></button>
      </div>
      <div ref={containerRef} className={styles.plot} role="group" aria-label={`${label}, ${interval}, displayed in ${timezone}. Use arrow keys to pan, plus and minus to zoom, Home to fit data.`} tabIndex={0} onKeyDown={onChartKeyDown} />
      <p ref={readoutRef} className={styles.readout} aria-live="off">{latestBar ? exactBarText(latestBar, timezone, isDaily(interval)) : "No candle values are available."}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {bars.length === 0 ? <p className={styles.empty}>No candles are available for this interval.</p> : null}
      <p className={styles.attribution}>Charting by <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a>. Market data is displayed as supplied.</p>
    </section>
  );
}
