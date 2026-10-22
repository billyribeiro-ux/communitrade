import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrawingController } from '../src/lib/drawings.ts';
import { createDrawingCoordinates, createSemanticTimeMapper, DrawingPrimitive, subscribeSemanticViewport } from '../src/components/charts/drawing-primitive.ts';

const time = value => new Date(value).toISOString();
const id = suffix => `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`;
const style = { color: '#2563eb', lineWidth: 2, lineStyle: 'solid', fillOpacity: 0.2 };
const dashedStyle = { ...style, lineStyle: 'dashed' };
const dottedStyle = { ...style, lineStyle: 'dotted' };
const at = (instant, price) => ({ time: time(instant), price: String(price) });

test('semantic mapping interpolates closed-session timestamps and extrapolates future whitespace without adding bars', () => {
  const friday = Date.parse('2026-10-16T20:00:00Z') / 1000;
  const monday = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const tuesday = Date.parse('2026-10-20T13:30:00Z') / 1000;
  const times = [friday, monday, tuesday];
  const mapper = createSemanticTimeMapper(times);
  const sunday = Date.parse('2026-10-18T12:00:00Z') / 1000;
  const sundayLogical = mapper.logicalAt(sunday);
  assert.ok(sundayLogical > 0 && sundayLogical < 1);
  assert.equal(mapper.epochAt(sundayLogical), sunday);
  assert.equal(mapper.epochAt(3), tuesday + 86400);
  assert.equal(mapper.logicalAt(tuesday + 86400), 3);
  assert.equal(times.length, 3);
});

test('coordinate mapping retains semantic anchors while projecting prices through series coordinates', () => {
  const friday = Date.parse('2026-10-16T20:00:00Z') / 1000;
  const monday = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const chart = { timeScale: () => ({ logicalToCoordinate: logical => logical * 20, coordinateToLogical: x => x / 20 }) };
  const series = {
    priceToCoordinate: price => 400 - price * 10,
    coordinateToPrice: y => (400 - y) / 10,
  };
  const mapper = createDrawingCoordinates(chart, series, [friday, monday], 2);
  const sunday = at('2026-10-18T12:00:00Z', '10.25');
  const point = mapper.toPoint(sunday);
  assert.ok(point);
  assert.equal(point.x, mapper.toPoint(sunday).x);
  assert.equal(point.y, 297.5);
  const roundTrip = mapper.toAnchor(point);
  assert.equal(roundTrip.time, sunday.time);
  assert.equal(roundTrip.price, sunday.price);
  const future = mapper.toPoint(at('2026-10-22T07:00:00Z', '11'));
  assert.deepEqual(future, { x: 40, y: 290 });
});

test('the v5 primitive draws all supported families on canvas and releases its controller subscription', () => {
  const drawings = [
    { id: id(1), type: 'horizontal', anchors: [at('2026-10-19T13:30:00Z', '10')], style },
    { id: id(2), type: 'trendline', anchors: [at('2026-10-19T13:30:00Z', '10'), at('2026-10-20T13:30:00Z', '11')], style: dashedStyle },
    { id: id(3), type: 'rectangle', anchors: [at('2026-10-19T13:30:00Z', '10'), at('2026-10-20T13:30:00Z', '11')], style },
    { id: id(4), type: 'arrow', anchors: [at('2026-10-19T13:30:00Z', '10'), at('2026-10-20T13:30:00Z', '11')], style: dottedStyle },
    { id: id(5), type: 'text', anchors: [at('2026-10-19T13:30:00Z', '10')], style, text: 'Canvas note' },
    { id: id(6), type: 'entry', anchors: [at('2026-10-19T13:30:00Z', '10')], style, planField: 'entryUnderlying' },
    { id: id(7), type: 'target', anchors: [at('2026-10-20T13:30:00Z', '11')], style, planField: 'targetUnderlying1' },
    { id: id(8), type: 'invalidation', anchors: [at('2026-10-19T13:30:00Z', '9')], style, planField: 'invalidationUnderlying' },
  ];
  const controller = new DrawingController(drawings);
  let redraws = 0;
  const t0 = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const chart = { timeScale: () => ({ logicalToCoordinate: logical => logical * 100, width: () => 500 }) };
  const series = { priceToCoordinate: price => 200 - price * 10 };
  const primitive = new DrawingPrimitive(chart, series, controller, [t0, t0 + 86400], 2);
  primitive.attached({ requestUpdate: () => { redraws += 1; } });
  const calls = [];
  const context = {
    canvas: { width: 1000 },
    save: () => calls.push('save'), restore: () => calls.push('restore'), scale: (x, y) => calls.push(`scale:${x}:${y}`),
    setLineDash: value => calls.push(`dash:${JSON.stringify(value)}`), beginPath: () => calls.push('path'), moveTo: () => {}, lineTo: (x, y) => calls.push(`lineTo:${x}:${y}`),
    stroke: () => calls.push('stroke'), fill: () => calls.push('fill'), fillRect: function () { calls.push(`fillRect:${this.globalAlpha}`); },
    strokeRect: () => calls.push('strokeRect'), arc: () => calls.push('arc'), fillText: (value, x, y) => calls.push(`text:${value}@${x}:${y}`),
    measureText: value => ({ width: value.length * 6 }),
  };
  const view = primitive.paneViews()[0];
  assert.equal(view.zOrder(), 'top');
  view.renderer().draw({ useBitmapCoordinateSpace: callback => callback({ context, horizontalPixelRatio: 2, verticalPixelRatio: 3 }) });
  assert.ok(calls.includes('scale:2:3'));
  assert.ok(calls.includes('lineTo:500:100'));
  assert.ok(calls.includes('fillRect:0.2'));
  assert.ok(calls.includes('strokeRect'));
  assert.ok(calls.some(value => value.startsWith('text:Canvas note@')));
  assert.ok(calls.some(value => value.startsWith('text:Entry@')));
  assert.ok(calls.some(value => value.startsWith('text:Target@')));
  assert.ok(calls.some(value => value.startsWith('text:Invalidation@')));
  assert.ok(calls.includes('dash:[7,5]'));
  assert.ok(calls.includes('dash:[2,4]'));
  assert.ok(calls.filter(value => value.startsWith('lineTo:')).length >= 5, 'trendline, arrow shaft, and both arrowhead strokes render');
  controller.select(id(5));
  const beforeSelectedRender = calls.filter(value => value === 'arc').length;
  view.renderer().draw({ useBitmapCoordinateSpace: callback => callback({ context, horizontalPixelRatio: 2, verticalPixelRatio: 3 }) });
  assert.ok(calls.filter(value => value === 'arc').length > beforeSelectedRender);
  const beforeSelection = redraws;
  controller.select(id(5));
  assert.equal(redraws, beforeSelection + 1);
  const beforeDetach = redraws;
  primitive.detached();
  controller.select(null);
  assert.equal(redraws, beforeDetach);
});

test('viewport subscription emits semantic UTC bounds and unsubscribes the exact chart handler', () => {
  const times = [10_000, 20_000, 50_000];
  let handler;
  let removed;
  let range = { from: 0.5, to: 1.5 };
  const timeScale = {
    subscribeVisibleLogicalRangeChange: listener => { handler = listener; },
    unsubscribeVisibleLogicalRangeChange: listener => { removed = listener; },
    getVisibleLogicalRange: () => range,
  };
  const chart = { timeScale: () => timeScale };
  const updates = [];
  const dispose = subscribeSemanticViewport(chart, () => times, viewport => updates.push(viewport));
  handler();
  assert.deepEqual(updates[0], {
    from: new Date(15_000_000).toISOString(), to: new Date(35_000_000).toISOString(),
  });
  range = null;
  handler();
  assert.equal(updates.length, 1);
  dispose(); dispose();
  assert.equal(removed, handler);
});

test('viewport subscription can suppress initial/data/theme range changes until the editor is ready', () => {
  let handler;
  let emit = false;
  let callbacks = 0;
  const timeScale = {
    subscribeVisibleLogicalRangeChange: listener => { handler = listener; },
    unsubscribeVisibleLogicalRangeChange: () => {},
    getVisibleLogicalRange: () => ({ from: 0, to: 1 }),
  };
  const chart = { timeScale: () => timeScale };
  const dispose = subscribeSemanticViewport(chart, () => [10_000, 20_000], () => { callbacks += 1; }, () => emit);
  handler(); // Initial viewport application and its synchronous callback are ignored.
  assert.equal(callbacks, 0);
  emit = true;
  handler(); // The user's first pan after mount is delivered.
  assert.equal(callbacks, 1);
  dispose();
});
