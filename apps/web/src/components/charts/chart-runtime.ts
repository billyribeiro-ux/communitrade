export interface ChartRenderer<Data> {
  setData(data: Data): void;
  setTheme(theme: string): void;
  resize(): void;
  dispose(): void;
}

export interface ChartLifecycleOptions<Data> {
  container: Element;
  data: Data;
  createRenderer(): ChartRenderer<Data>;
  readTheme(): string;
  createResizeObserver?(callback: () => void): { observe(target: Element): void; disconnect(): void };
  createMutationObserver?(callback: () => void): { observe(target: Element, options: MutationObserverInit): void; disconnect(): void };
  mediaQuery?: MediaQueryList | null;
}

export interface CrosshairSource<Param> {
  subscribeCrosshairMove(handler: (param: Param) => void): void;
  unsubscribeCrosshairMove(handler: (param: Param) => void): void;
}

/** Retains the exact handler identity so chart mouse/touch subscriptions cannot leak. */
export function subscribeChartCrosshair<Param>(chart: CrosshairSource<Param>, handler: (param: Param) => void) {
  chart.subscribeCrosshairMove(handler);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    chart.unsubscribeCrosshairMove(handler);
  };
}

export function initialLogicalRange(
  dataLength: number,
  interval: string,
  previous: { interval: string; range: { from: number; to: number } } | null,
) {
  if (dataLength <= 0) return null;
  if (previous?.interval === interval) {
    const max = dataLength - 1;
    const width = Math.max(1, Math.min(dataLength, previous.range.to - previous.range.from));
    const to = Math.max(width - 1, Math.min(max, previous.range.to));
    return { from: Math.max(0, to - width), to };
  }
  const to = dataLength - 1;
  return { from: Math.max(0, to - 119), to };
}

export type CompactTickKind = "year" | "month" | "day" | "time" | "time-seconds";

export function formatCompactTimeTick(epochSeconds: number, timezone: string, kind: CompactTickKind) {
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.valueOf())) return "";
  const options: Intl.DateTimeFormatOptions = kind === "year"
    ? { timeZone: timezone, year: "2-digit" }
    : kind === "month"
      ? { timeZone: timezone, month: "short" }
      : kind === "day"
        ? { timeZone: timezone, day: "numeric" }
        : kind === "time-seconds"
          ? { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }
          : { timeZone: timezone, hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

export function initializeChartResources<Chart, Result>(
  createChart: () => Chart,
  initialize: (chart: Chart, registerCleanup: (cleanup: () => void) => void) => Result,
  removeChart: (chart: Chart) => void,
) {
  const chart = createChart();
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    try { removeChart(chart); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Chart cleanup failed");
  };
  try {
    const resources = initialize(chart, (cleanup) => cleanups.push(cleanup));
    return { chart, resources, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Owns all browser subscriptions for one chart mount. Safe to dispose repeatedly. */
export function mountChartLifecycle<Data>(options: ChartLifecycleOptions<Data>) {
  const renderer = options.createRenderer();
  let disposed = false;
  let listeningToMedia = false;
  let resizeObserver: ReturnType<NonNullable<ChartLifecycleOptions<Data>["createResizeObserver"]>> | undefined;
  let mutationObserver: ReturnType<NonNullable<ChartLifecycleOptions<Data>["createMutationObserver"]>> | undefined;

  const refreshTheme = () => {
    if (!disposed) renderer.setTheme(options.readTheme());
  };
  const onMediaChange = () => refreshTheme();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    try { resizeObserver?.disconnect(); } catch (error) { errors.push(error); }
    try { mutationObserver?.disconnect(); } catch (error) { errors.push(error); }
    try { if (listeningToMedia) options.mediaQuery?.removeEventListener("change", onMediaChange); } catch (error) { errors.push(error); }
    try { renderer.dispose(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Chart lifecycle cleanup failed");
  };

  try {
    renderer.setTheme(options.readTheme());
    renderer.setData(options.data);
    const ResizeObserverType = options.createResizeObserver ?? ((callback) => new ResizeObserver(callback));
    const MutationObserverType = options.createMutationObserver ?? ((callback) => new MutationObserver(callback));
    resizeObserver = ResizeObserverType(() => { if (!disposed) renderer.resize(); });
    resizeObserver.observe(options.container);
    const root = options.container.ownerDocument.documentElement;
    mutationObserver = MutationObserverType(refreshTheme);
    mutationObserver.observe(root, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    if (options.mediaQuery) {
      options.mediaQuery.addEventListener("change", onMediaChange);
      listeningToMedia = true;
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    update(data: Data) {
      if (!disposed) renderer.setData(data);
    },
    refreshTheme,
    dispose,
  };
}
