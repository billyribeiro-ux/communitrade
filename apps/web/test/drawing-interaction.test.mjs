import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrawingController } from '../src/lib/drawings.ts';
import { attachDrawingInteraction } from '../src/components/charts/drawing-interaction.ts';

const drawing = {
  id: '11111111-1111-4111-8111-000000000001', type: 'horizontal',
  anchors: [{ time: '2026-10-20T14:30:00.000Z', price: '10.00' }],
  style: { color: '#2563eb', lineWidth: 2, lineStyle: 'solid', fillOpacity: 0.2 },
};

class MockElement extends EventTarget {
  style = { touchAction: 'auto', cursor: '' };
  captured = null;
  insideEditable = false;
  mobile = false;
  ownerDocument = { defaultView: { matchMedia: () => ({ matches: this.mobile }) } };
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture() { this.captured = null; }
  closest() { return this.insideEditable ? {} : null; }
}

function pointer(element, type, x, y, overrides = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
    clientX: x + 10, clientY: y + 20, ...overrides,
  });
  element.dispatchEvent(event);
  return event;
}

function key(element, key, overrides = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides,
  });
  element.dispatchEvent(event);
  return event;
}

function bridge(element, controller) {
  const coordinates = {
    toPoint: anchor => ({ x: 10, y: Number(anchor.price) * 10 }),
    toAnchor: point => ({ time: '2026-10-20T14:30:00.000Z', price: (point.y / 10).toFixed(2) }),
  };
  const chart = { paneSize: () => ({ width: 100, height: 200 }) };
  return attachDrawingInteraction({
    element, chart, series: {}, controller, getCoordinates: () => coordinates,
    hitTest: (point) => point.x < 30 ? { drawingId: drawing.id, part: 'handle', anchorIndex: 0 } : null,
  });
}

test('drawing gestures capture and block chart pan; empty select clicks pass through for chart pan', () => {
  const element = new MockElement();
  const controller = new DrawingController([]);
  controller.setTool('horizontal');
  const dispose = bridge(element, controller);
  const down = pointer(element, 'pointerdown', 20, 100);
  assert.equal(down.defaultPrevented, true);
  assert.equal(element.captured, 1);
  pointer(element, 'pointermove', 20, 110);
  pointer(element, 'pointerup', 20, 110);
  assert.equal(controller.getSnapshot().drawings.length, 1);
  assert.equal(element.captured, null);
  controller.setTool('select');
  const miss = pointer(element, 'pointerdown', 60, 150);
  assert.equal(miss.defaultPrevented, false);
  assert.equal(element.captured, null);
  dispose();
});

test('only primary pointers start gestures; secondary touch and non-plot axes do not intercept chart gestures', () => {
  const element = new MockElement();
  const controller = new DrawingController([]);
  controller.setTool('horizontal');
  const dispose = bridge(element, controller);
  assert.equal(pointer(element, 'pointerdown', 10, 20, { isPrimary: false }).defaultPrevented, false);
  assert.equal(pointer(element, 'pointerdown', 150, 20).defaultPrevented, false);
  assert.equal(controller.getSnapshot().drawings.length, 0);
  dispose();
});

test('the mobile bridge blocks advanced creation but leaves horizontal creation available', () => {
  const element = new MockElement();
  element.mobile = true;
  const controller = new DrawingController([]);
  controller.setTool('arrow'); // A stale desktop tool remains blocked after a resize to mobile.
  const dispose = bridge(element, controller);
  assert.equal(pointer(element, 'pointerdown', 20, 100).defaultPrevented, false);
  assert.equal(controller.getSnapshot().drawings.length, 0);
  controller.setTool('horizontal');
  assert.equal(pointer(element, 'pointerdown', 20, 100).defaultPrevented, true);
  pointer(element, 'pointerup', 20, 100);
  assert.equal(controller.getSnapshot().drawings.length, 1);
  dispose();
});

test('keyboard Delete, undo, redo, and Escape work outside editors and listeners are removed on cleanup', () => {
  const previousElement = globalThis.Element;
  globalThis.Element = MockElement;
  try {
    const element = new MockElement();
    const controller = new DrawingController([drawing]);
    const dispose = bridge(element, controller);
    controller.select(drawing.id);
    assert.equal(key(element, 'Delete').defaultPrevented, true);
    assert.equal(controller.getSnapshot().drawings.length, 0);
    key(element, 'z', { ctrlKey: true });
    assert.equal(controller.getSnapshot().drawings.length, 1);
    key(element, 'z', { ctrlKey: true, shiftKey: true });
    assert.equal(controller.getSnapshot().drawings.length, 0);
    element.insideEditable = true;
    assert.equal(key(element, 'z', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(controller.getSnapshot().drawings.length, 0);
    element.insideEditable = false;
    controller.setTool('horizontal');
    const pending = pointer(element, 'pointerdown', 20, 100);
    assert.equal(pending.defaultPrevented, true);
    assert.equal(key(element, 'Escape').defaultPrevented, true);
    assert.equal(element.captured, null);
    assert.equal(controller.getSnapshot().preview, undefined);
    dispose(); dispose();
    assert.equal(element.style.touchAction, 'auto');
    const afterDispose = pointer(element, 'pointerdown', 20, 100);
    assert.equal(afterDispose.defaultPrevented, false);
    assert.equal(controller.getSnapshot().drawings.length, 0);
  } finally {
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
  }
});
