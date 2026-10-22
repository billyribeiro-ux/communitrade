"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  ArrowUUpLeft, ArrowUUpRight, ArrowUpRight, Check, Cursor, Minus, Rectangle, SignIn,
  Target, TextT, Trash, TrendUp, WarningCircle, X,
} from "@phosphor-icons/react";
import type { Anchor, Drawing, DrawingController, DrawingStyle, DrawingTool, DrawingType } from "../../lib/drawings";
import styles from "./DrawingTools.module.css";

type PlanField = Extract<Drawing, { type: "entry" | "target" | "invalidation" }>["planField"];
type Draft = {
  type: DrawingType;
  time1: string;
  price1: string;
  time2: string;
  price2: string;
  text: string;
  color: string;
  lineWidth: string;
  lineStyle: DrawingStyle["lineStyle"];
  fillOpacity: string;
  planField: PlanField;
};

const tools: readonly { type: DrawingTool; label: string; icon: typeof Cursor; create: boolean }[] = [
  { type: "select", label: "Select and edit", icon: Cursor, create: false },
  { type: "horizontal", label: "Horizontal line", icon: Minus, create: true },
  { type: "trendline", label: "Trendline", icon: TrendUp, create: true },
  { type: "rectangle", label: "Rectangle", icon: Rectangle, create: true },
  { type: "arrow", label: "Arrow", icon: ArrowUpRight, create: true },
  { type: "text", label: "Text", icon: TextT, create: true },
  { type: "entry", label: "Entry level", icon: SignIn, create: true },
  { type: "target", label: "Target level", icon: Target, create: true },
  { type: "invalidation", label: "Invalidation level", icon: WarningCircle, create: true },
];
const drawingTypes: readonly DrawingType[] = ["horizontal", "trendline", "rectangle", "arrow", "text", "entry", "target", "invalidation"];
const defaultPlanField: Record<DrawingType, PlanField | ""> = {
  horizontal: "", trendline: "", rectangle: "", arrow: "", text: "",
  entry: "entryUnderlying", target: "targetUnderlying1", invalidation: "invalidationUnderlying",
};
const labels: Record<DrawingType, string> = {
  horizontal: "Horizontal line", trendline: "Trendline", rectangle: "Rectangle", arrow: "Arrow",
  text: "Text", entry: "Entry", target: "Target", invalidation: "Invalidation",
};

function blankDraft(type: DrawingType, style: DrawingStyle, anchor?: Anchor): Draft {
  const time = anchor?.time ?? "";
  const price = anchor?.price ?? "";
  return {
    type, time1: time, price1: price, time2: time, price2: price, text: "",
    color: style.color, lineWidth: String(style.lineWidth), lineStyle: style.lineStyle,
    fillOpacity: String(style.fillOpacity), planField: defaultPlanField[type] as PlanField,
  };
}

function draftFromDrawing(drawing: Drawing): Draft {
  return {
    type: drawing.type, time1: drawing.anchors[0]?.time ?? "", price1: drawing.anchors[0]?.price ?? "",
    time2: drawing.anchors[1]?.time ?? drawing.anchors[0]?.time ?? "",
    price2: drawing.anchors[1]?.price ?? drawing.anchors[0]?.price ?? "",
    text: drawing.text ?? "", color: drawing.style.color, lineWidth: String(drawing.style.lineWidth),
    lineStyle: drawing.style.lineStyle, fillOpacity: String(drawing.style.fillOpacity),
    planField: "planField" in drawing ? drawing.planField : defaultPlanField[drawing.type] as PlanField,
  };
}

function styleFromDraft(draft: Draft): DrawingStyle {
  return {
    color: draft.color,
    lineWidth: Number(draft.lineWidth),
    lineStyle: draft.lineStyle,
    fillOpacity: Number(draft.fillOpacity),
  };
}

function anchorFromDraft(time: string, price: string): Anchor {
  return { time: time.trim(), price: price.trim() };
}

function createDrawing(draft: Draft, id: string): Drawing {
  const one = anchorFromDraft(draft.time1, draft.price1);
  const two = anchorFromDraft(draft.time2, draft.price2);
  const style = styleFromDraft(draft);
  const text = draft.text;
  switch (draft.type) {
    case "horizontal": return { id, type: draft.type, anchors: [one], style, ...(text ? { text } : {}) };
    case "trendline": return { id, type: draft.type, anchors: [one, two], style, ...(text ? { text } : {}) };
    case "rectangle": return { id, type: draft.type, anchors: [one, two], style, ...(text ? { text } : {}) };
    case "arrow": return { id, type: draft.type, anchors: [one, two], style, ...(text ? { text } : {}) };
    case "text": return { id, type: draft.type, anchors: [one], style, text };
    case "entry": return { id, type: draft.type, anchors: [one], style, planField: "entryUnderlying", ...(text ? { text } : {}) };
    case "target": return { id, type: draft.type, anchors: [one], style, planField: draft.planField as Extract<Drawing, { type: "target" }>["planField"], ...(text ? { text } : {}) };
    case "invalidation": return { id, type: draft.type, anchors: [one], style, planField: "invalidationUnderlying", ...(text ? { text } : {}) };
  }
}

function editDrawing(current: Drawing, draft: Draft): Drawing {
  const next = createDrawing(draft, current.id);
  return next;
}

function formatDrawing(drawing: Drawing): string {
  const price = drawing.anchors.map(item => `${item.time} · ${item.price}`).join(" → ");
  return `${labels[drawing.type]} · ${price}${drawing.text ? ` · ${drawing.text}` : ""}`;
}

export function DrawingTools({ controller, disabled = false, defaultAnchor }: {
  controller: DrawingController;
  disabled?: boolean;
  defaultAnchor?: Anchor;
}) {
  const id = useId();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState<Draft>(() => blankDraft("horizontal", snapshot.style, defaultAnchor));
  const [createType, setCreateType] = useState<DrawingType>("horizontal");
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(false);
  const textField = useRef<HTMLTextAreaElement>(null);
  const selected = useMemo(() => snapshot.drawings.find(item => item.id === snapshot.selectedId), [snapshot.drawings, snapshot.selectedId]);
  const previousSnapshot = useRef(snapshot);
  const currentDraftType = selected ? selected.type : createType;
  const twoAnchors = currentDraftType === "trendline" || currentDraftType === "rectangle" || currentDraftType === "arrow";
  const inputPrefix = `${id}-drawing`;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (disabled) {
      controller.cancel();
      controller.setTool("select");
    }
  }, [controller, disabled]);

  useEffect(() => {
    if (mobile && snapshot.tool !== "select" && snapshot.tool !== "horizontal" && snapshot.tool !== "text") controller.setTool("select");
  }, [controller, mobile, snapshot.tool]);

  useEffect(() => {
    const previous = previousSnapshot.current;
    previousSnapshot.current = snapshot;
    const isNewPointerText = selected?.type === "text" && !selected.text
      && previous.tool === "text" && !previous.drawings.some(item => item.id === selected.id);
    if (isNewPointerText) textField.current?.focus();
  }, [selected, snapshot]);

  useEffect(() => {
    if (selected) setDraft(draftFromDrawing(selected));
    else setDraft(blankDraft(createType, snapshot.style, defaultAnchor));
    setError("");
  }, [selected?.id, snapshot.drawings, snapshot.style, createType, defaultAnchor]);

  function selectTool(tool: DrawingTool) {
    if (disabled || (mobile && tool !== "select" && tool !== "horizontal" && tool !== "text")) return;
    setError("");
    if (tool !== "select") {
      setCreateType(tool);
      setDraft(blankDraft(tool, snapshot.style, defaultAnchor));
    }
    controller.setTool(tool);
  }

  function chooseType(type: DrawingType) {
    if (disabled || selected) return;
    setCreateType(type);
    setDraft(blankDraft(type, snapshot.style, defaultAnchor));
    setError("");
  }

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    try {
      if (mobile && !selected && draft.type !== "horizontal" && draft.type !== "text") throw new Error("On a touch screen, create horizontal lines and text. Existing drawings remain editable.");
      const nextStyle = styleFromDraft(draft);
      if (selected) {
        controller.update(editDrawing(selected, draft));
        controller.setStyle(nextStyle);
      }
      else {
        const drawing = createDrawing(draft, globalThis.crypto.randomUUID());
        controller.add(drawing);
        controller.setStyle(nextStyle);
        controller.select(drawing.id);
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The drawing could not be saved. Check the values and try again.");
    }
  }

  function deleteSelected() {
    if (disabled || !selected) return;
    try { controller.removeSelected(); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The drawing could not be deleted."); }
  }

  return <section className={styles.tools} aria-labelledby={`${id}-heading`}>
    <div className={styles.header}>
      <div><h3 id={`${id}-heading`}>Chart drawings</h3><p className={styles.count} aria-live="polite">{snapshot.drawings.length} of 50 drawings</p></div>
      <div className={styles.history}>
        <button type="button" onClick={() => controller.undo()} disabled={disabled || !snapshot.canUndo} aria-label="Undo drawing change"><ArrowUUpLeft size={18} aria-hidden="true"/>Undo</button>
        <button type="button" onClick={() => controller.redo()} disabled={disabled || !snapshot.canRedo} aria-label="Redo drawing change"><ArrowUUpRight size={18} aria-hidden="true"/>Redo</button>
        {snapshot.selectedId && <button type="button" onClick={deleteSelected} disabled={disabled} aria-label="Delete selected drawing"><Trash size={18} aria-hidden="true"/>Delete</button>}
        {snapshot.preview && <button type="button" onClick={() => controller.cancel()} disabled={disabled} aria-label="Cancel drawing preview"><X size={18} aria-hidden="true"/>Cancel</button>}
      </div>
    </div>

    <div className={styles.toolbar} role="group" aria-label="Drawing tools">
      {tools.map(({ type, label, icon: Icon, create }) => {
        const blockedOnMobile = mobile && create && type !== "horizontal" && type !== "text";
        return <button type="button" key={type} aria-pressed={snapshot.tool === type} aria-label={label}
          onClick={() => selectTool(type)} disabled={disabled || blockedOnMobile || (create && snapshot.drawings.length >= 50)}>
          <Icon size={19} aria-hidden="true"/><span>{label}</span>
        </button>;
      })}
    </div>
    {mobile && <p className={styles.mobileHelp}>On a touch screen, create horizontal lines and text. You can still select, move, and edit existing drawings.</p>}
    {disabled && <p className={styles.locked} role="status">Drawing edits are locked for this chart.</p>}

    <div className={styles.body}>
      <div className={styles.objectPanel}>
        <h4 id={`${id}-objects-heading`}>Objects</h4>
        {snapshot.drawings.length === 0 ? <p className={styles.empty}>No drawings yet.</p> : <ul aria-labelledby={`${id}-objects-heading`}>
          {snapshot.drawings.map(item => <li key={item.id}>
            <button type="button" aria-current={snapshot.selectedId === item.id ? "true" : undefined} onClick={() => { if (!disabled) controller.select(item.id); }} disabled={disabled}>
              <span className={styles.objectType}>{labels[item.type]}</span><span>{formatDrawing(item)}</span>
            </button>
          </li>)}
        </ul>}
      </div>

      <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-form-heading`}>
        <div className={styles.formHeading}>
          <h4 id={`${id}-form-heading`}>{selected ? `Edit ${labels[selected.type]}` : "Create by values"}</h4>
          {selected && <button className={styles.textButton} type="button" onClick={() => { if (!disabled) controller.select(null); }} disabled={disabled}>New drawing</button>}
        </div>
        {!selected && <label className={styles.field}>Drawing type
          <select value={createType} onChange={event => chooseType(event.target.value as DrawingType)} disabled={disabled}>
            {drawingTypes.map(type => <option key={type} value={type} disabled={mobile && type !== "horizontal" && type !== "text"}>{labels[type]}</option>)}
          </select>
        </label>}

        <fieldset className={styles.anchorGroup}>
          <legend>{twoAnchors ? "First anchor" : "Anchor"}</legend>
          <label className={styles.field}>UTC time
            <input type="text" inputMode="text" autoComplete="off" placeholder="2026-10-20T14:30:00.000Z" value={draft.time1} onChange={event => update("time1", event.target.value)} required disabled={disabled}/>
          </label>
          <label className={styles.field}>Price in underlying
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="100.00" value={draft.price1} onChange={event => update("price1", event.target.value)} required disabled={disabled}/>
          </label>
        </fieldset>
        {twoAnchors && <fieldset className={styles.anchorGroup}>
          <legend>Second anchor</legend>
          <label className={styles.field}>UTC time
            <input type="text" inputMode="text" autoComplete="off" placeholder="Enter a UTC timestamp" value={draft.time2} onChange={event => update("time2", event.target.value)} required disabled={disabled}/>
          </label>
          <label className={styles.field}>Price in underlying
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="Enter a price" value={draft.price2} onChange={event => update("price2", event.target.value)} required disabled={disabled}/>
          </label>
          <p className={styles.help}>The timestamp may fall in a closed session or history gap. The chart keeps the exact semantic time and price.</p>
        </fieldset>}

        {(currentDraftType === "entry" || currentDraftType === "target" || currentDraftType === "invalidation") && <label className={styles.field}>Trade plan field
          <select value={draft.planField} onChange={event => update("planField", event.target.value as PlanField)} disabled={disabled || currentDraftType !== "target"}>
            {currentDraftType === "entry" && <option value="entryUnderlying">Entry · underlying</option>}
            {currentDraftType === "target" && <><option value="targetUnderlying1">Target 1 · underlying</option><option value="targetUnderlying2">Target 2 · underlying</option><option value="targetUnderlying3">Target 3 · underlying</option></>}
            {currentDraftType === "invalidation" && <option value="invalidationUnderlying">Invalidation · underlying</option>}
          </select>
        </label>}

        <label className={styles.field}>Annotation text <span className={styles.optional}>(optional except for text objects)</span>
          <textarea ref={textField} rows={3} maxLength={500} value={draft.text} onChange={event => update("text", event.target.value)} disabled={disabled} required={currentDraftType === "text"} aria-describedby={`${inputPrefix}-text-count`}/>
          <span id={`${inputPrefix}-text-count`} className={styles.help}>{draft.text.length} of 500 characters. Text is stored as plain text.</span>
        </label>

        <fieldset className={styles.styleFields}>
          <legend>Drawing style</legend>
          <label className={styles.field}>Hex color
            <input type="text" inputMode="text" autoComplete="off" pattern="#[0-9a-fA-F]{6}" maxLength={7} placeholder="#2563EB" value={draft.color} onChange={event => update("color", event.target.value)} required disabled={disabled}/>
          </label>
          <label className={styles.field}>Line width
            <select value={draft.lineWidth} onChange={event => update("lineWidth", event.target.value)} disabled={disabled}>{[1, 2, 3, 4].map(width => <option key={width} value={width}>{width}px</option>)}</select>
          </label>
          <label className={styles.field}>Line style
            <select value={draft.lineStyle} onChange={event => update("lineStyle", event.target.value as DrawingStyle["lineStyle"])} disabled={disabled}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select>
          </label>
          <label className={styles.field}>Fill opacity
            <input type="number" min="0" max="1" step="0.01" value={draft.fillOpacity} onChange={event => update("fillOpacity", event.target.value)} required disabled={disabled}/>
          </label>
        </fieldset>
        {!selected && <button className={styles.apply} type="submit" disabled={disabled || snapshot.drawings.length >= 50 || (mobile && createType !== "horizontal" && createType !== "text")}><Check size={18} aria-hidden="true"/>Create drawing</button>}
        {selected && <button className={styles.apply} type="submit" disabled={disabled}><Check size={18} aria-hidden="true"/>Apply changes</button>}
      </form>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
