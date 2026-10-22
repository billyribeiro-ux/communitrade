import type { components } from '@trading/contracts';

type ChartState = components['schemas']['ChartState'];
export type Drawing = ChartState['drawings'][number];
export type Anchor = Drawing['anchors'][number];
export type DrawingStyle = Drawing['style'];
export type Style = DrawingStyle;
export type DrawingType = Drawing['type'];
export type DrawingTool = DrawingType | 'select';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Maps semantic chart anchors to/from the current viewport. Null means the
 * anchor is outside the mapper's supported coordinates; callers must retain it. */
export interface Coordinates {
  toPoint(anchor: Anchor): Point | null;
  toAnchor(point: Point): Anchor | null;
}

export interface DrawingPreview {
  readonly type: DrawingType;
  readonly anchors: readonly Anchor[];
  readonly style: DrawingStyle;
  readonly text?: string;
  readonly planField?: 'entryUnderlying' | 'targetUnderlying1' | 'targetUnderlying2' | 'targetUnderlying3' | 'invalidationUnderlying';
}

export interface DrawingSnapshot {
  readonly drawings: readonly Drawing[];
  readonly selectedId: string | null;
  readonly tool: DrawingTool;
  readonly style: DrawingStyle;
  readonly preview?: DrawingPreview;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export type DrawingHit =
  | { readonly drawingId: string; readonly part: 'handle'; readonly anchorIndex: number }
  | { readonly drawingId: string; readonly part: 'body' };

export interface DrawingControllerOptions {
  readonly createId?: () => string;
  /** Mobile creation is limited to horizontal and text tools. */
  readonly isMobile?: boolean;
}

export const MAX_DRAWINGS = 50;
export const MAX_TEXT_LENGTH = 500;
export const HANDLE_HIT_RADIUS = 9;
export const DEFAULT_HIT_TOLERANCE = 8;
export const DEFAULT_DRAWING_STYLE: DrawingStyle = Object.freeze({
  color: '#2563eb', lineWidth: 2, lineStyle: 'solid', fillOpacity: 0.15,
});

const TWO_ANCHOR_TYPES = new Set<DrawingType>(['trendline', 'rectangle', 'arrow']);
const PLAN_FIELD_BY_TYPE: Partial<Record<DrawingType, DrawingPreview['planField']>> = {
  entry: 'entryUnderlying', target: 'targetUnderlying1', invalidation: 'invalidationUnderlying',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function cloneDrawing(drawing: Drawing): Drawing {
  return Object.freeze({
    ...drawing,
    anchors: Object.freeze(drawing.anchors.map(anchor => Object.freeze({ time: anchor.time, price: anchor.price }))),
    style: Object.freeze({ ...drawing.style }),
  }) as Drawing;
}

function cloneDrawings(drawings: readonly Drawing[]): readonly Drawing[] {
  return Object.freeze(drawings.map(cloneDrawing));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validAnchor(anchor: unknown): anchor is Anchor {
  if (!isRecord(anchor) || Object.keys(anchor).some(key => key !== 'time' && key !== 'price')) return false;
  if (typeof anchor.time !== 'string' || !ISO_UTC.test(anchor.time) || !Number.isFinite(Date.parse(anchor.time))) return false;
  const canonical = new Date(anchor.time).toISOString();
  if (anchor.time !== canonical && anchor.time !== canonical.replace('.000Z', 'Z')) return false;
  return typeof anchor.price === 'string' && DECIMAL.test(anchor.price);
}

function validStyle(style: unknown): style is DrawingStyle {
  return isRecord(style)
    && Object.keys(style).length === 4
    && typeof style.color === 'string' && COLOR.test(style.color)
    && Number.isInteger(style.lineWidth) && Number(style.lineWidth) >= 1 && Number(style.lineWidth) <= 4
    && ['solid', 'dashed', 'dotted'].includes(String(style.lineStyle))
    && typeof style.fillOpacity === 'number' && Number.isFinite(style.fillOpacity)
    && style.fillOpacity >= 0 && style.fillOpacity <= 1;
}

function expectedAnchorCount(type: DrawingType): number {
  return TWO_ANCHOR_TYPES.has(type) ? 2 : 1;
}

/** Throws before state changes if an object would not satisfy the chart schema. */
export function assertValidDrawing(value: unknown): asserts value is Drawing {
  if (!isRecord(value)) throw new TypeError('Drawing must be an object');
  const type = value.type as DrawingType;
  if (!['horizontal', 'trendline', 'rectangle', 'arrow', 'text', 'entry', 'target', 'invalidation'].includes(type)) {
    throw new TypeError('Unsupported drawing type');
  }
  if (Object.keys(value).some(key => !['id', 'type', 'anchors', 'style', 'text', 'planField'].includes(key))) throw new TypeError('Unexpected drawing field');
  if (typeof value.id !== 'string' || !UUID.test(value.id)) throw new TypeError('Drawing id must be a UUID');
  if (!Array.isArray(value.anchors) || value.anchors.length !== expectedAnchorCount(type) || !value.anchors.every(validAnchor)) throw new TypeError('Drawing anchors do not match its type');
  if (!validStyle(value.style)) throw new TypeError('Invalid drawing style');
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > MAX_TEXT_LENGTH)) throw new TypeError('Drawing text must be plain text of at most 500 characters');
  if (type === 'text' && typeof value.text !== 'string') throw new TypeError('Text drawing requires text');
  if (type === 'entry' && value.planField !== 'entryUnderlying') throw new TypeError('Entry drawing requires its underlying plan field');
  if (type === 'target' && !['targetUnderlying1', 'targetUnderlying2', 'targetUnderlying3'].includes(String(value.planField))) throw new TypeError('Target drawing requires its underlying plan field');
  if (type === 'invalidation' && value.planField !== 'invalidationUnderlying') throw new TypeError('Invalidation drawing requires its underlying plan field');
  if (type !== 'entry' && type !== 'target' && type !== 'invalidation' && value.planField !== undefined) throw new TypeError('Unexpected plan field');
}

function assertValidCollection(drawings: readonly Drawing[]): void {
  if (!Array.isArray(drawings) || drawings.length > MAX_DRAWINGS) throw new RangeError('A chart can contain at most 50 drawings');
  const ids = new Set<string>();
  const planFields = new Set<string>();
  for (const drawing of drawings) {
    assertValidDrawing(drawing);
    if (ids.has(drawing.id)) throw new TypeError('Drawing ids must be unique');
    ids.add(drawing.id);
    if ('planField' in drawing) {
      if (planFields.has(drawing.planField)) throw new TypeError('Only one drawing may link to each plan field');
      planFields.add(drawing.planField);
    }
  }
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (!denominator) return pointDistance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return pointDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function mappedPoints(drawing: Drawing, coordinates: Coordinates): readonly (Point | null)[] {
  return drawing.anchors.map(anchor => {
    const point = coordinates.toPoint(anchor);
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  });
}

function bodyHit(drawing: Drawing, point: Point, coordinates: Coordinates, tolerance: number): boolean {
  const points = mappedPoints(drawing, coordinates);
  const a = points[0];
  if (!a) return false;
  if (drawing.type === 'horizontal' || drawing.type === 'entry' || drawing.type === 'target' || drawing.type === 'invalidation') {
    return Math.abs(point.y - a.y) <= tolerance;
  }
  if (drawing.type === 'text') {
    // Canvas text extends to the right and below its anchor. A small circular
    // hit target made the visible end of a label impossible to select.
    const width = Math.max(16, (drawing.text?.length ?? 0) * 8);
    return point.x >= a.x - tolerance && point.x <= a.x + width + tolerance
      && point.y >= a.y - tolerance && point.y <= a.y + 20 + tolerance;
  }
  const b = points[1];
  if (!b) return false;
  if (drawing.type === 'rectangle') {
    const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y); const bottom = Math.max(a.y, b.y);
    const nearEdge = point.x >= left - tolerance && point.x <= right + tolerance && point.y >= top - tolerance && point.y <= bottom + tolerance
      && (Math.min(Math.abs(point.x - left), Math.abs(point.x - right), Math.abs(point.y - top), Math.abs(point.y - bottom)) <= tolerance);
    const inside = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    return nearEdge || inside;
  }
  return segmentDistance(point, a, b) <= tolerance;
}

/** Hit handles before bodies, and objects from topmost (last) to bottommost. */
export function hitTestDrawings(
  drawings: readonly Drawing[], point: Point, coordinates: Coordinates, tolerance = DEFAULT_HIT_TOLERANCE,
): DrawingHit | null {
  if (![point.x, point.y, tolerance].every(Number.isFinite) || tolerance < 0) return null;
  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const drawing = drawings[index]!;
    const points = mappedPoints(drawing, coordinates);
    for (let anchorIndex = 0; anchorIndex < points.length; anchorIndex += 1) {
      const anchorPoint = points[anchorIndex];
      if (anchorPoint && pointDistance(point, anchorPoint) <= Math.max(tolerance, HANDLE_HIT_RADIUS)) {
        return { drawingId: drawing.id, part: 'handle', anchorIndex };
      }
    }
  }
  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const drawing = drawings[index]!;
    if (bodyHit(drawing, point, coordinates, tolerance)) return { drawingId: drawing.id, part: 'body' };
  }
  return null;
}

/** Canvas-space bounds; null when any semantic anchor is outside the current mapper. */
export function drawingBounds(drawing: Drawing, coordinates: Coordinates): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null {
  const points = mappedPoints(drawing, coordinates);
  if (points.some(point => point === null)) return null;
  const concrete = points as readonly Point[];
  return Object.freeze({
    left: Math.min(...concrete.map(point => point.x)), right: Math.max(...concrete.map(point => point.x)),
    top: Math.min(...concrete.map(point => point.y)), bottom: Math.max(...concrete.map(point => point.y)),
  });
}

interface ActiveGesture {
  readonly mode: 'create-one' | 'create-two-first' | 'create-two-second' | 'move' | 'anchor';
  readonly start: Point;
  readonly before: readonly Drawing[];
  readonly id?: string;
  readonly anchorIndex?: number;
  readonly coordinates?: Coordinates;
  readonly created?: DrawingPreview;
}

const defaultId = (): string => globalThis.crypto.randomUUID();

/** Pure semantic drawing state plus pointer gestures. Geometry is supplied by the live chart mapper. */
export class DrawingController {
  private drawings: readonly Drawing[];
  private selectedId: string | null = null;
  private tool: DrawingTool = 'select';
  private preview: DrawingPreview | undefined;
  private gesture: ActiveGesture | undefined;
  private undoStack: (readonly Drawing[])[] = [];
  private redoStack: (readonly Drawing[])[] = [];
  private readonly listeners = new Set<() => void>();
  private style: DrawingStyle = DEFAULT_DRAWING_STYLE;
  private readonly createId: () => string;
  private readonly isMobile: boolean;
  private snapshot: DrawingSnapshot;

  constructor(initial: readonly Drawing[], options: DrawingControllerOptions = {}) {
    assertValidCollection(initial);
    this.drawings = cloneDrawings(initial);
    this.createId = options.createId ?? defaultId;
    this.isMobile = options.isMobile ?? false;
    this.snapshot = this.makeSnapshot();
  }

  getSnapshot = (): DrawingSnapshot => this.snapshot;

  /** Latest semantic drawings safe to persist. Active move/anchor gestures stay provisional. */
  getCommittedDrawings(): readonly Drawing[] {
    if (this.gesture?.mode === 'move' || this.gesture?.mode === 'anchor') return this.gesture.before;
    return this.drawings;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private makeSnapshot(): DrawingSnapshot {
    return Object.freeze({
      drawings: this.drawings, selectedId: this.selectedId, tool: this.tool,
      style: this.style,
      ...(this.preview ? { preview: this.preview } : {}),
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
    });
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  private record(before: readonly Drawing[]): void {
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private commit(drawings: readonly Drawing[], before = this.drawings): void {
    assertValidCollection(drawings);
    this.record(before);
    this.drawings = cloneDrawings(drawings);
    this.preview = undefined;
    this.gesture = undefined;
    this.publish();
  }

  setTool(tool: DrawingTool): void {
    if (!['select', 'horizontal', 'trendline', 'rectangle', 'arrow', 'text', 'entry', 'target', 'invalidation'].includes(tool)) throw new TypeError('Unsupported drawing tool');
    if (this.gesture) this.cancel();
    this.tool = tool;
    this.preview = undefined;
    this.publish();
  }

  setStyle(style: DrawingStyle): void {
    if (!validStyle(style)) throw new TypeError('Invalid drawing style');
    this.style = Object.freeze({ ...style });
    this.publish();
  }

  add(drawing: Drawing): void {
    if (this.gesture) this.cancel();
    assertValidDrawing(drawing);
    if (this.drawings.length >= MAX_DRAWINGS) throw new RangeError('A chart can contain at most 50 drawings');
    if (this.drawings.some(item => item.id === drawing.id)) throw new TypeError('Drawing ids must be unique');
    this.commit([...this.drawings, drawing]);
    this.selectedId = drawing.id;
    this.publish();
  }

  update(drawing: Drawing): void {
    if (this.gesture) this.cancel();
    assertValidDrawing(drawing);
    const index = this.drawings.findIndex(item => item.id === drawing.id);
    if (index < 0) throw new TypeError('Cannot update a drawing that is not in this chart');
    const next = [...this.drawings];
    next[index] = drawing;
    this.commit(next);
  }

  select(id: string | null): void {
    if (id !== null && !this.drawings.some(drawing => drawing.id === id)) throw new TypeError('Cannot select a drawing that is not in this chart');
    this.selectedId = id;
    this.publish();
  }

  removeSelected(): void {
    if (this.gesture) this.cancel();
    if (!this.selectedId) return;
    const next = this.drawings.filter(drawing => drawing.id !== this.selectedId);
    if (next.length === this.drawings.length) return;
    this.commit(next);
    this.selectedId = null;
    this.publish();
  }

  undo(): void {
    // Pointer drags are provisional until pointerUp. Restore their starting
    // snapshot first so redo never captures a half-finished drag.
    if (this.gesture) { this.cancel(); return; }
    if (this.preview) { this.preview = undefined; this.publish(); return; }
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.drawings);
    this.drawings = previous;
    if (this.selectedId && !previous.some(drawing => drawing.id === this.selectedId)) this.selectedId = null;
    this.preview = undefined; this.gesture = undefined;
    this.publish();
  }

  redo(): void {
    if (this.gesture) { this.cancel(); return; }
    if (this.preview) { this.preview = undefined; this.publish(); return; }
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.drawings);
    this.drawings = next;
    if (this.selectedId && !next.some(drawing => drawing.id === this.selectedId)) this.selectedId = null;
    this.preview = undefined; this.gesture = undefined;
    this.publish();
  }

  replace(drawings: readonly Drawing[]): void {
    assertValidCollection(drawings);
    this.drawings = cloneDrawings(drawings);
    this.selectedId = null; this.preview = undefined; this.gesture = undefined;
    this.undoStack = []; this.redoStack = [];
    this.publish();
  }

  cancel(): void {
    if (!this.gesture && !this.preview) return;
    if (this.gesture && (this.gesture.mode === 'move' || this.gesture.mode === 'anchor')) {
      this.drawings = this.gesture.before;
    }
    this.gesture = undefined;
    this.preview = undefined;
    this.publish();
  }

  pointerDown(point: Point, coordinates: Coordinates): boolean {
    if (!finitePoint(point)) return false;
    if (this.tool === 'select') {
      const hit = hitTestDrawings(this.drawings, point, coordinates);
      this.selectedId = hit?.drawingId ?? null;
      if (!hit) { this.publish(); return false; }
      this.gesture = {
        mode: hit.part === 'handle' ? 'anchor' : 'move', start: point, before: this.drawings,
        id: hit.drawingId, ...(hit.part === 'handle' ? { anchorIndex: hit.anchorIndex } : {}), coordinates,
      };
      this.publish();
      return true;
    }
    if (this.isMobile && this.tool !== 'horizontal' && this.tool !== 'text') return false;
    if (this.drawings.length >= MAX_DRAWINGS) return false;
    const requestedPlanField = PLAN_FIELD_BY_TYPE[this.tool];
    if (requestedPlanField && this.drawings.some(drawing => 'planField' in drawing && drawing.planField === requestedPlanField)) return false;
    if (this.preview && TWO_ANCHOR_TYPES.has(this.preview.type)) {
      const anchor = coordinates.toAnchor(point);
      if (!anchor || !validAnchor(anchor)) return false;
      this.preview = Object.freeze({ ...this.preview, anchors: Object.freeze([this.preview.anchors[0]!, anchor]) });
      this.gesture = { mode: 'create-two-second', start: point, before: this.drawings, created: this.preview };
      this.publish();
      return true;
    }
    const anchor = coordinates.toAnchor(point);
    if (!anchor || !validAnchor(anchor)) return false;
    if (TWO_ANCHOR_TYPES.has(this.tool)) {
      const preview: DrawingPreview = Object.freeze({ type: this.tool, anchors: Object.freeze([anchor]), style: this.style });
      this.preview = preview;
      this.gesture = { mode: 'create-two-first', start: point, before: this.drawings, created: preview };
    } else {
      const type = this.tool;
      this.preview = Object.freeze({
        type, anchors: Object.freeze([anchor]), style: this.style,
        ...(type === 'text' ? { text: '' } : {}), ...(PLAN_FIELD_BY_TYPE[type] ? { planField: PLAN_FIELD_BY_TYPE[type] } : {}),
      });
      this.gesture = { mode: 'create-one', start: point, before: this.drawings, created: this.preview };
    }
    this.publish();
    return true;
  }

  pointerMove(point: Point, coordinates: Coordinates): boolean {
    if (!finitePoint(point) || !this.gesture) return false;
    const gesture = this.gesture;
    if (gesture.mode === 'create-two-first' || gesture.mode === 'create-two-second') {
      const anchor = coordinates.toAnchor(point);
      if (!anchor || !validAnchor(anchor)) return true;
      const first = gesture.created?.anchors[0] ?? this.preview?.anchors[0];
      if (first) this.preview = Object.freeze({ ...this.preview!, anchors: Object.freeze([first, anchor]) });
      this.publish();
      return true;
    }
    if (gesture.mode === 'create-one') {
      const anchor = coordinates.toAnchor(point);
      if (anchor && validAnchor(anchor) && this.preview) {
        this.preview = Object.freeze({ ...this.preview, anchors: Object.freeze([anchor]) });
        this.publish();
      }
      return true;
    }
    const original = gesture.before.find(drawing => drawing.id === gesture.id);
    if (!original) return false;
    const next = [...gesture.before];
    const index = next.findIndex(drawing => drawing.id === original.id);
    const anchors = original.anchors.slice();
    if (gesture.mode === 'anchor') {
      const anchor = coordinates.toAnchor(point);
      if (anchor && validAnchor(anchor)) anchors[gesture.anchorIndex!] = anchor;
    } else {
      const dx = point.x - gesture.start.x; const dy = point.y - gesture.start.y;
      for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
        const mapped = gesture.coordinates?.toPoint(anchors[anchorIndex]!);
        if (!mapped) continue;
        const anchor = coordinates.toAnchor({ x: mapped.x + dx, y: mapped.y + dy });
        if (anchor && validAnchor(anchor)) anchors[anchorIndex] = anchor;
      }
    }
    next[index] = { ...original, anchors } as Drawing;
    this.drawings = cloneDrawings(next);
    this.publish();
    return true;
  }

  pointerUp(point: Point, coordinates: Coordinates): boolean {
    const gesture = this.gesture;
    if (!gesture) return false;
    if (!finitePoint(point)) { this.cancel(); return true; }
    if (gesture.mode === 'create-one') {
      const finalAnchor = coordinates.toAnchor(point);
      const anchor = finalAnchor && validAnchor(finalAnchor) ? finalAnchor : this.preview?.anchors[0];
      if (!anchor || !this.preview) { this.cancel(); return true; }
      // pointerUp can be delivered after the last pointerMove (or without one
      // at all), so use its final coordinate when the mapper supports it.
      const preview = Object.freeze({ ...this.preview, anchors: Object.freeze([anchor]) });
      const drawing = previewToDrawing(preview, this.createId());
      this.commit([...this.drawings, drawing], gesture.before);
      this.selectedId = drawing.id; this.tool = 'select'; this.publish();
      return true;
    }
    if (gesture.mode === 'create-two-first') {
      if (!this.preview) { this.cancel(); return true; }
      this.gesture = undefined;
      this.publish();
      return true;
    }
    if (gesture.mode === 'create-two-second') {
      const anchor = coordinates.toAnchor(point);
      if (!anchor || !this.preview) { this.cancel(); return true; }
      const preview = Object.freeze({ ...this.preview, anchors: Object.freeze([this.preview.anchors[0]!, anchor]) });
      const drawing = previewToDrawing(preview, this.createId());
      this.commit([...this.drawings, drawing], gesture.before);
      this.selectedId = drawing.id; this.tool = 'select'; this.publish();
      return true;
    }
    const changed = JSON.stringify(gesture.before) !== JSON.stringify(this.drawings);
    this.gesture = undefined;
    if (changed) {
      this.record(gesture.before);
      this.drawings = cloneDrawings(this.drawings);
    }
    this.publish();
    return true;
  }
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function previewToDrawing(preview: DrawingPreview, id: string): Drawing {
  const candidate = {
    id, type: preview.type, anchors: preview.anchors, style: preview.style,
    ...(preview.text !== undefined ? { text: preview.text } : {}),
    ...(preview.planField ? { planField: preview.planField } : {}),
  } as Drawing;
  assertValidDrawing(candidate);
  return candidate;
}
