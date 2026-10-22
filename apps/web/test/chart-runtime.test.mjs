import test from "node:test";
import assert from "node:assert/strict";
import { formatCompactTimeTick, initialLogicalRange, initializeChartResources, mountChartLifecycle, subscribeChartCrosshair } from "../src/components/charts/chart-runtime.ts";

function fixture({ failOnData = false } = {}) {
  const calls = [];
  const element = { ownerDocument: { documentElement: { name: "root" } } };
  const observers = [];
  const listeners = new Map();
  const mediaQuery = {
    addEventListener(type, handler) { listeners.set(type, handler); calls.push(`media:add:${type}`); },
    removeEventListener(type, handler) {
      assert.equal(listeners.get(type), handler);
      listeners.delete(type);
      calls.push(`media:remove:${type}`);
    },
  };
  let theme = "dark";
  const options = {
    container: element,
    data: [1],
    readTheme: () => theme,
    mediaQuery,
    createRenderer: () => ({
      setTheme(value) { calls.push(`theme:${value}`); },
      setData(value) {
        calls.push(`data:${value.join(",")}`);
        if (failOnData) throw new Error("bad data");
      },
      resize() { calls.push("resize"); },
      dispose() { calls.push("dispose"); },
    }),
    createResizeObserver(callback) {
      const observer = {
        callback,
        target: null,
        observe(target) { this.target = target; calls.push("resize:observe"); },
        disconnect() { calls.push("resize:disconnect"); },
      };
      observers.push(observer);
      return observer;
    },
    createMutationObserver(callback) {
      const observer = {
        callback,
        target: null,
        config: null,
        observe(target, config) { this.target = target; this.config = config; calls.push("mutation:observe"); },
        disconnect() { calls.push("mutation:disconnect"); },
      };
      observers.push(observer);
      return observer;
    },
  };
  return { options, calls, observers, listeners, setTheme(value) { theme = value; } };
}

test("chart lifecycle reacts to resize, theme and data changes and removes every subscription", () => {
  const f = fixture();
  const lifecycle = mountChartLifecycle(f.options);
  assert.deepEqual(f.calls.slice(0, 3), ["theme:dark", "data:1", "resize:observe"]);
  assert.equal(f.observers[0].target, f.options.container);
  assert.equal(f.observers[1].target, f.options.container.ownerDocument.documentElement);
  assert.deepEqual(f.observers[1].config, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  assert.equal(f.listeners.size, 1);

  f.observers[0].callback();
  f.setTheme("light");
  f.observers[1].callback();
  f.listeners.get("change")();
  lifecycle.update([2, 3]);
  assert.equal(f.calls.filter((call) => call === "resize").length, 1);
  assert.equal(f.calls.filter((call) => call === "theme:light").length, 2);
  assert.ok(f.calls.includes("data:2,3"));

  lifecycle.dispose();
  lifecycle.dispose();
  assert.equal(f.calls.filter((call) => call === "resize:disconnect").length, 1);
  assert.equal(f.calls.filter((call) => call === "mutation:disconnect").length, 1);
  assert.equal(f.calls.filter((call) => call === "media:remove:change").length, 1);
  assert.equal(f.calls.filter((call) => call === "dispose").length, 1);
  f.observers[0].callback();
  f.observers[1].callback();
  assert.equal(f.calls.filter((call) => call === "resize").length, 1);
  assert.equal(f.calls.filter((call) => call === "theme:light").length, 2);
});

test("a repeated mount owns a fresh observer and renderer set", () => {
  const first = fixture();
  const mountedOnce = mountChartLifecycle(first.options);
  mountedOnce.dispose();
  const second = fixture();
  const mountedAgain = mountChartLifecycle(second.options);
  second.setTheme("light");
  second.observers[1].callback();
  mountedAgain.update([9]);
  mountedAgain.dispose();
  assert.equal(first.calls.filter((call) => call === "dispose").length, 1);
  assert.equal(second.calls.filter((call) => call === "dispose").length, 1);
  assert.ok(second.calls.includes("theme:light"));
  assert.ok(second.calls.includes("data:9"));
});

test("partial initialization disposes its renderer when initial data application fails", () => {
  const f = fixture({ failOnData: true });
  assert.throws(() => mountChartLifecycle(f.options), /bad data/);
  assert.equal(f.calls.filter((call) => call === "dispose").length, 1);
  assert.equal(f.calls.filter((call) => call === "resize:observe").length, 0);
  assert.equal(f.calls.filter((call) => call === "media:add:change").length, 0);
});

test("crosshair subscription forwards events and removes the same handler exactly once", () => {
  const calls = [];
  const listeners = new Set();
  const chart = {
    subscribeCrosshairMove(handler) { listeners.add(handler); calls.push("subscribe"); },
    unsubscribeCrosshairMove(handler) { assert.ok(listeners.delete(handler)); calls.push("unsubscribe"); },
  };
  const received = [];
  const remove = subscribeChartCrosshair(chart, (param) => received.push(param));
  const handler = [...listeners][0];
  handler({ time: 123 });
  remove();
  remove();
  assert.deepEqual(received, [{ time: 123 }]);
  assert.deepEqual(calls, ["subscribe", "unsubscribe"]);
  assert.equal(listeners.size, 0);
});

test("observer creation failure removes any earlier observer and disposes the renderer", () => {
  const f = fixture();
  f.options.createMutationObserver = () => { throw new Error("observer unavailable"); };
  assert.throws(() => mountChartLifecycle(f.options), /observer unavailable/);
  assert.ok(f.calls.includes("resize:disconnect"));
  assert.equal(f.calls.filter((call) => call === "dispose").length, 1);
  assert.equal(f.listeners.size, 0);
});

test("initial viewport defaults to the latest 120 bars and restores only matching intervals", () => {
  assert.deepEqual(initialLogicalRange(500, "15m", null), { from: 380, to: 499 });
  assert.deepEqual(initialLogicalRange(30, "1d", null), { from: 0, to: 29 });
  assert.deepEqual(initialLogicalRange(500, "15m", { interval: "15m", range: { from: 30, to: 90 } }), { from: 30, to: 90 });
  assert.deepEqual(initialLogicalRange(20, "15m", { interval: "15m", range: { from: 30, to: 90 } }), { from: 0, to: 19 });
  assert.deepEqual(initialLogicalRange(500, "1d", { interval: "15m", range: { from: 30, to: 90 } }), { from: 380, to: 499 });
});

test("compact time ticks honor the selected timezone and stay short", () => {
  const epoch = Date.parse("2026-10-20T13:30:00Z") / 1000;
  for (const kind of ["year", "month", "day", "time", "time-seconds"]) {
    assert.ok(formatCompactTimeTick(epoch, "America/New_York", kind).length <= 8);
  }
  assert.equal(formatCompactTimeTick(epoch, "America/New_York", "time"), "9:30 AM");
  assert.equal(formatCompactTimeTick(epoch, "UTC", "time"), "1:30 PM");
  assert.equal(formatCompactTimeTick(Date.parse("2026-03-08T06:30:00Z") / 1000, "America/New_York", "time"), "1:30 AM");
  assert.equal(formatCompactTimeTick(Date.parse("2026-03-08T07:30:00Z") / 1000, "America/New_York", "time"), "3:30 AM");
});

test("chart resource adapter creates series and removes crosshair subscriptions before chart removal", () => {
  const calls = [];
  const handlers = new Set();
  const fakeChart = {
    addSeries(kind) { calls.push(`series:${kind}`); return { kind }; },
    subscribeCrosshairMove(handler) { handlers.add(handler); calls.push("crosshair:subscribe"); },
    unsubscribeCrosshairMove(handler) { handlers.delete(handler); calls.push("crosshair:unsubscribe"); },
    remove() { calls.push("chart:remove"); },
  };
  const built = initializeChartResources(
    () => fakeChart,
    (chart, registerCleanup) => {
      const candles = chart.addSeries("candles");
      const volume = chart.addSeries("volume");
      registerCleanup(subscribeChartCrosshair(chart, () => {}));
      return { candles, volume };
    },
    (chart) => chart.remove(),
  );
  assert.deepEqual(built.resources, { candles: { kind: "candles" }, volume: { kind: "volume" } });
  assert.deepEqual(calls, ["series:candles", "series:volume", "crosshair:subscribe"]);
  built.dispose();
  built.dispose();
  assert.deepEqual(calls.slice(-2), ["crosshair:unsubscribe", "chart:remove"]);
  assert.equal(handlers.size, 0);
});

test("chart resource adapter removes a partially initialized chart when series creation fails", () => {
  const calls = [];
  const chart = {
    addSeries(kind) {
      calls.push(`series:${kind}`);
      if (kind === "volume") throw new Error("volume series unavailable");
      return { kind };
    },
    remove() { calls.push("chart:remove"); },
  };
  assert.throws(() => initializeChartResources(
    () => chart,
    (instance) => { instance.addSeries("candles"); instance.addSeries("volume"); },
    (instance) => instance.remove(),
  ), /volume series unavailable/);
  assert.deepEqual(calls, ["series:candles", "series:volume", "chart:remove"]);
});
