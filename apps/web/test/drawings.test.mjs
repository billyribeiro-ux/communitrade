import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DrawingController, assertValidDrawing, drawingBounds, hitTestDrawings,
  MAX_DRAWINGS,
} from '../src/lib/drawings.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const style = { color: '#12abEF', lineWidth: 2, lineStyle: 'solid', fillOpacity: 0.25 };
const anchor = (time = '2026-10-20T14:30:00.000Z', price = '100.00') => ({ time, price });
const drawing = (type, n, anchors = [anchor()], extra = {}) => ({ id: id(n), type, anchors, style, ...extra });
const families = [
  drawing('horizontal', 1),
  drawing('trendline', 2, [anchor('2026-10-20T14:30:00Z', '99.125'), anchor('2026-10-20T15:30:00Z', '102.875')]),
  drawing('rectangle', 3, [anchor('2026-10-20T14:30:00Z', '99'), anchor('2026-10-20T15:30:00Z', '102')]),
  drawing('arrow', 4, [anchor('2026-10-20T14:30:00Z', '99'), anchor('2026-10-20T15:30:00Z', '102')]),
  drawing('text', 5, [anchor()], { text: '<img src=x onerror=alert(1)>' }),
  drawing('entry', 6, [anchor()], { planField: 'entryUnderlying' }),
  drawing('target', 7, [anchor()], { planField: 'targetUnderlying2' }),
  drawing('invalidation', 8, [anchor()], { planField: 'invalidationUnderlying' }),
];
const coords = {
  toPoint: a => ({ x: Date.parse(a.time) / 60_000, y: Number(a.price) }),
  toAnchor: p => Number.isFinite(p.x) && Number.isFinite(p.y)
    ? { time: new Date(p.x * 60_000).toISOString(), price: p.y.toFixed(3) } : null,
};
const _fixed = (anchorValue) => ({
  toPoint: candidate => candidate.time === anchorValue.time ? ({ x: 10, y: Number(candidate.price) }) : null,
  toAnchor: point => ({ time: anchorValue.time, price: point.y.toFixed(2) }),
});

 test('accepts all eight schema drawing families and serializes exact semantic values as plain JSON', () => {
  for (const item of families) assert.doesNotThrow(() => assertValidDrawing(item));
  const store = new DrawingController(families);
  const json = JSON.parse(JSON.stringify(store.getSnapshot().drawings));
  assert.equal(json[1].anchors[0].price, '99.125');
  assert.equal(json[1].anchors[1].time, '2026-10-20T15:30:00Z');
  assert.equal(json[4].text, '<img src=x onerror=alert(1)>');
  assert.equal(typeof json[4].text, 'string', 'text remains inert plain data for a textContent/canvas renderer');
  assert.equal(Object.isFrozen(store.getSnapshot()), true);
  assert.equal(Object.isFrozen(store.getSnapshot().drawings[0].anchors[0]), true);
});

test('rejects invalid colors, text length, malformed anchors, duplicate ids, duplicate plan links and object 51', () => {
  assert.throws(() => new DrawingController([drawing('horizontal', 1), drawing('horizontal', 1)]), /unique/i);
  assert.throws(() => assertValidDrawing(drawing('horizontal', 2, [anchor('2026-02-30T14:30:00Z')])), /anchors/i);
  assert.throws(() => assertValidDrawing(drawing('text', 3, [anchor()], { text: 'x'.repeat(501) })), /500/i);
  assert.throws(() => assertValidDrawing(drawing('horizontal', 4, [anchor()], { style: { ...style, color: 'red' } })), /style/i);
  assert.throws(() => new DrawingController([
    drawing('target', 5, [anchor()], { planField: 'targetUnderlying1' }),
    drawing('target', 6, [anchor()], { planField: 'targetUnderlying1' }),
  ]), /plan field/i);
  const store = new DrawingController([]);
  for (let index = 1; index <= MAX_DRAWINGS; index += 1) store.add(drawing('horizontal', index));
  assert.equal(store.getSnapshot().drawings.length, 50);
  assert.throws(() => store.add(drawing('horizontal', 51)), /50/i);
});

test('uses handle priority, then topmost object order for bodies across drawing geometries', () => {
  const lineA = drawing('trendline', 20, [anchor('1970-01-01T00:00:00.000Z', '0'), anchor('1970-01-01T01:40:00.000Z', '100')]);
  const lineB = drawing('trendline', 21, [anchor('1970-01-01T00:00:00.000Z', '0'), anchor('1970-01-01T01:40:00.000Z', '100')]);
  const atMiddle = { x: 50, y: 50 };
  assert.deepEqual(hitTestDrawings([lineA, lineB], atMiddle, coords), { drawingId: lineB.id, part: 'body' });
  assert.deepEqual(hitTestDrawings([lineA, lineB], { x: 0, y: 0 }, coords), { drawingId: lineB.id, part: 'handle', anchorIndex: 0 });
  const rect = drawing('rectangle', 22, [anchor('1970-01-01T00:00:00.000Z', '0'), anchor('1970-01-01T01:40:00.000Z', '100')]);
  assert.deepEqual(hitTestDrawings([rect], { x: 50, y: 50 }, coords), { drawingId: rect.id, part: 'body' });
  const overlay = drawing('entry', 23, [anchor('1970-01-01T00:10:00.000Z', '10')], { planField: 'entryUnderlying' });
  assert.deepEqual(hitTestDrawings([overlay], { x: 100, y: 10 }, coords), { drawingId: overlay.id, part: 'body' });
  const text = drawing('text', 24, [anchor('1970-01-01T00:00:00.000Z', '20')], { text: 'A long visible label' });
  assert.deepEqual(hitTestDrawings([text], { x: 120, y: 22 }, coords), { drawingId: text.id, part: 'body' }, 'the visible label area is selectable beyond its anchor handle');
  assert.equal(drawingBounds(lineA, coords).right, 100);
});

test('one-anchor and two-placement tools create one undo unit; cancellation keeps the chart unchanged', () => {
  let serial = 30;
  const store = new DrawingController([], { createId: () => id(serial++) });
  const listenerCalls = [];
  const unsubscribe = store.subscribe(() => listenerCalls.push(store.getSnapshot()));
  store.setTool('horizontal');
  assert.equal(store.pointerDown({ x: 0, y: 100 }, coords), true);
  assert.equal(store.getSnapshot().drawings.length, 0);
  assert.equal(store.pointerUp({ x: 0, y: 100 }, coords), true);
  assert.equal(store.getSnapshot().drawings.length, 1);
  assert.equal(store.getSnapshot().selectedId, id(30));
  assert.equal(store.getSnapshot().canUndo, true);
  store.undo();
  assert.equal(store.getSnapshot().drawings.length, 0);
  store.redo();
  assert.equal(store.getSnapshot().drawings.length, 1);
  store.setTool('trendline');
  store.pointerDown({ x: 2, y: 99 }, coords);
  store.pointerUp({ x: 2, y: 99 }, coords);
  assert.equal(store.getSnapshot().preview.anchors.length, 1);
  store.pointerDown({ x: 3, y: 102 }, coords);
  store.pointerMove({ x: 4, y: 103 }, coords);
  store.pointerUp({ x: 4, y: 103 }, coords);
  assert.equal(store.getSnapshot().drawings.length, 2);
  assert.equal(store.getSnapshot().drawings[1].anchors.length, 2);
  store.setTool('rectangle');
  store.pointerDown({ x: 5, y: 90 }, coords);
  store.pointerUp({ x: 5, y: 90 }, coords);
  store.cancel();
  assert.equal(store.getSnapshot().drawings.length, 2);
  assert.equal(store.getSnapshot().preview, undefined);
  assert.ok(listenerCalls.length > 0);
  unsubscribe();
});

test('one-anchor pointerUp uses its final coordinate even when no pointerMove arrived', () => {
  const store = new DrawingController([], { createId: () => id(39) });
  store.setTool('horizontal');
  assert.equal(store.pointerDown({ x: 1, y: 10 }, coords), true);
  // Browser pointerup can carry a newer coordinate than the last move event.
  assert.equal(store.pointerUp({ x: 5, y: 25 }, coords), true);
  assert.deepEqual(store.getSnapshot().drawings[0].anchors[0], {
    time: new Date(5 * 60_000).toISOString(), price: '25.000',
  });
});

test('undo during a provisional drag first cancels it without adding transient redo state', () => {
  const original = drawing('horizontal', 45, [anchor('1970-01-01T00:00:00.000Z', '10')]);
  const mapping = {
    toPoint: () => ({ x: 0, y: 10 }),
    toAnchor: point => ({ time: '1970-01-01T00:00:00.000Z', price: point.y.toFixed(2) }),
  };
  const store = new DrawingController([original]);
  store.pointerDown({ x: 0, y: 10 }, mapping);
  store.pointerMove({ x: 0, y: 20 }, mapping);
  store.undo();
  assert.equal(store.getSnapshot().drawings[0].anchors[0].price, '10');
  assert.equal(store.getSnapshot().canRedo, false);
  store.redo();
  assert.equal(store.getSnapshot().drawings[0].anchors[0].price, '10');
});

test('undo branches clear redo and replacement resets selection, preview, and history', () => {
  let serial = 40;
  const store = new DrawingController([], { createId: () => id(serial++) });
  store.add(drawing('horizontal', 41));
  store.add(drawing('horizontal', 42));
  store.undo();
  assert.equal(store.getSnapshot().canRedo, true);
  store.add(drawing('horizontal', 43));
  assert.equal(store.getSnapshot().canRedo, false);
  store.setTool('trendline');
  store.pointerDown({ x: 2, y: 99 }, coords);
  store.pointerUp({ x: 2, y: 99 }, coords);
  store.replace([drawing('text', 44, [anchor()], { text: 'reloaded' })]);
  assert.equal(store.getSnapshot().selectedId, null);
  assert.equal(store.getSnapshot().preview, undefined);
  assert.equal(store.getSnapshot().canUndo, false);
  assert.equal(store.getSnapshot().canRedo, false);
});

test('dragging uses live viewport conversion and preserves anchors the mapper cannot render', () => {
  const first = anchor('2026-03-08T06:30:00.000Z', '100.0000000001'); // after New York DST transition
  const second = anchor('2026-03-09T13:30:00.000Z', '101.125'); // across a weekend/session gap
  const line = drawing('trendline', 50, [first, second]);
  const store = new DrawingController([line]);
  const committedBefore = store.getCommittedDrawings();
  const mapping = {
    toPoint: candidate => candidate.time === first.time ? { x: 10, y: 100 } : null,
    toAnchor: point => ({ time: '2026-03-08T06:30:00.000Z', price: point.y.toFixed(2) }),
  };
  store.pointerDown({ x: 10, y: 100 }, mapping);
  store.pointerMove({ x: 12, y: 102 }, mapping);
  assert.equal(store.getSnapshot().drawings[0].anchors[0].price, '102.00', 'the live primitive receives provisional geometry');
  assert.equal(store.getCommittedDrawings(), committedBefore, 'autosave continues to see the committed snapshot during an active drag');
  store.pointerUp({ x: 12, y: 102 }, mapping);
  const moved = store.getSnapshot().drawings[0];
  assert.equal(store.getCommittedDrawings()[0].anchors[0].price, '102.00', 'pointerUp publishes the committed geometry');
  assert.equal(moved.anchors[0].price, '102.00');
  assert.equal(moved.anchors[0].time, first.time);
  assert.equal(moved.anchors[1].price, second.price, 'unmapped future/session-gap anchor remains semantically exact');
  assert.equal(moved.anchors[1].time, second.time);
  store.undo();
  assert.equal(store.getSnapshot().drawings[0].anchors[0].price, '100.0000000001');
  store.pointerDown({ x: 10, y: 100 }, mapping);
  store.pointerMove({ x: 13, y: 103 }, mapping);
  store.cancel();
  assert.equal(store.getSnapshot().drawings[0].anchors[0].price, '100.0000000001', 'cancel restores the gesture start without adding history');
  assert.equal(store.getCommittedDrawings()[0].anchors[0].price, '100.0000000001', 'cancel leaves the committed geometry unchanged');
  assert.equal(store.getSnapshot().canRedo, true, 'a canceled edit does not branch history');
});

test('closed overnight futures coordinates stay semantic and never require fabricated candles', () => {
  const overnight = drawing('trendline', 55, [
    anchor('2026-10-20T21:00:00.000Z', '5800.25'), // session close
    anchor('2026-10-21T00:00:00.000Z', '5804.75'), // overnight closed gap
  ]);
  const liveViewport = {
    toPoint: candidate => candidate.time === overnight.anchors[0].time ? { x: 300, y: 5800.25 } : null,
    toAnchor: point => ({ time: '2026-10-20T21:00:00.000Z', price: point.y.toFixed(2) }),
  };
  assert.equal(drawingBounds(overnight, liveViewport), null);
  const store = new DrawingController([overnight]);
  store.pointerDown({ x: 300, y: 5800.25 }, liveViewport);
  store.pointerMove({ x: 302, y: 5802.25 }, liveViewport);
  store.pointerUp({ x: 302, y: 5802.25 }, liveViewport);
  assert.equal(store.getSnapshot().drawings[0].anchors[1].time, overnight.anchors[1].time);
  assert.equal(store.getSnapshot().drawings[0].anchors[1].price, overnight.anchors[1].price);
});

test('mobile controller only starts horizontal and text creation while existing object editing remains available', () => {
  const store = new DrawingController([families[0]], { isMobile: true, createId: () => id(60) });
  store.setTool('arrow');
  assert.equal(store.pointerDown({ x: 10, y: 100 }, coords), false);
  store.setTool('horizontal');
  assert.equal(store.pointerDown({ x: 10, y: 100 }, coords), true);
  store.cancel();
  store.setTool('select');
  assert.equal(store.pointerDown({ x: Date.parse(families[0].anchors[0].time) / 60_000, y: 100 }, coords), true);
});

test('plan-linked pointer tools refuse a duplicate field without throwing or creating a preview', () => {
  const store = new DrawingController([
    drawing('entry', 61, [anchor()], { planField: 'entryUnderlying' }),
  ]);
  store.setTool('entry');
  assert.equal(store.pointerDown({ x: 10, y: 100 }, coords), false);
  assert.equal(store.getSnapshot().preview, undefined);
  assert.equal(store.getSnapshot().drawings.length, 1);
});
