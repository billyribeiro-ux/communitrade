import type { components } from "@trading/contracts";

type ChartState = components["schemas"]["ChartState"];
type ChartDocument = components["schemas"]["ChartDocument"];
export type SaveChart = (state: ChartState, revision: number, signal: AbortSignal) => Promise<ChartDocument>;
export type AutosaveSnapshot = Readonly<{ status: "saved" | "unsaved" | "saving" | "error" | "conflict"; revision: number; message: string }>;

/** Serializes optimistic chart writes and keeps edits made during an in-flight save. */
export class ChartAutosave {
  private save: SaveChart;
  private latest: ChartState;
  private acknowledged: string;
  private revision: number;
  private pending = false;
  private saving = false;
  private blocked = false;
  private disposed = false;
  private generation = 0;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;
  private listeners = new Set<() => void>();
  private snapshot: AutosaveSnapshot;
  private onSaved: ((document: ChartDocument, stillCurrent: boolean) => void) | undefined;

  constructor(initial: ChartDocument, save: SaveChart, options: { delayMs?: number; onSaved?: (document: ChartDocument, stillCurrent: boolean) => void } = {}) {
    this.latest = initial.state;
    this.acknowledged = JSON.stringify(initial.state);
    this.revision = initial.revision;
    this.save = save;
    this.delay = options.delayMs ?? 700;
    this.onSaved = options.onSaved;
    this.snapshot = { status: "saved", revision: initial.revision, message: "All chart changes saved." };
  }
  getSnapshot = (): AutosaveSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getLocalState = (): ChartState => this.latest;
  private emit(status: AutosaveSnapshot["status"], message: string) {
    if (this.disposed) return;
    this.snapshot = { status, revision: this.revision, message };
    for (const listener of this.listeners) listener();
  }
  queue(state: ChartState, force = false) {
    if (this.disposed) return;
    this.latest = state;
    this.pending = force || JSON.stringify(state) !== this.acknowledged;
    clearTimeout(this.timer);
    if (this.blocked) return;
    if (!this.pending && !this.saving) { this.emit("saved", "All chart changes saved."); return; }
    this.emit(this.saving ? "saving" : "unsaved", this.saving ? "Saving chart; newer edits remain pending." : "Unsaved chart changes.");
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.disposed || this.saving || this.blocked || !this.pending) return;
    const generation = this.generation;
    const sent = this.latest;
    const serialized = JSON.stringify(sent);
    const controller = new AbortController();
    this.active = controller;
    this.saving = true;
    this.pending = false;
    this.emit("saving", "Saving chart…");
    try {
      const document = await this.save(sent, this.revision, controller.signal);
      if (this.disposed || generation !== this.generation) return;
      const stillCurrent = JSON.stringify(this.latest) === serialized;
      this.revision = document.revision;
      this.acknowledged = JSON.stringify(document.state);
      if (stillCurrent) this.latest = document.state;
      this.pending = !stillCurrent;
      this.saving = false;
      this.active = undefined;
      this.emit(this.pending ? "unsaved" : "saved", this.pending ? "Newer chart changes are waiting to save." : "All chart changes saved.");
      // A presentation refresh failure cannot turn a confirmed write into a failed write.
      try { this.onSaved?.(document, stillCurrent); } catch { /* The acknowledgement remains authoritative. */ }
      if (this.pending) this.timer = setTimeout(() => { void this.flush(); }, this.delay);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.saving = false;
      this.active = undefined;
      this.pending = true;
      this.blocked = true;
      const conflict = typeof error === "object" && error !== null && "status" in error && error.status === 409;
      const validation = typeof error === "object" && error !== null && "status" in error && error.status === 422 && error instanceof Error;
      this.emit(conflict ? "conflict" : "error", conflict ? "A newer saved chart exists. Your local edits are preserved. Reload the latest saved chart before editing further." : validation ? error.message : "Chart save failed. Your local edits are still unsaved. Retry when the service is available.");
    }
  }
  retry() {
    if (this.disposed || this.snapshot.status === "conflict") return;
    this.blocked = false;
    void this.flush();
  }
  replace(document: ChartDocument) {
    clearTimeout(this.timer);
    this.generation += 1;
    this.active?.abort();
    this.active = undefined;
    this.latest = document.state;
    this.revision = document.revision;
    this.acknowledged = JSON.stringify(document.state);
    this.pending = false;
    this.saving = false;
    this.blocked = false;
    this.emit("saved", "Latest saved chart loaded.");
  }
  dispose() {
    this.disposed = true;
    this.generation += 1;
    clearTimeout(this.timer);
    this.active?.abort();
    this.listeners.clear();
  }
}
