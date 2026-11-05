/**
 * Cuts of the same footage, played in step. A sample's `source` names its footage and the source
 * ranges it plays, in play order (studio's keep spans, or any edit list). Pure: the page and the
 * agent use the same maps. No db import, so the portal can load it.
 */

/** One kept range of the footage, seconds on the raw track. */
export interface Span {
  s: number;
  e: number;
}

/** Where a cut comes from: `ref` names the footage (`studio:12`, a file hash); `spans` in play order. */
export interface Source {
  ref: string;
  spans: Span[];
}

export const isSource = (x: unknown): x is Source =>
  !!x &&
  typeof x === "object" &&
  typeof (x as Source).ref === "string" &&
  Array.isArray((x as Source).spans) &&
  (x as Source).spans.every(
    (p) => p && Number.isFinite(p.s) && Number.isFinite(p.e) && p.e > p.s && p.s >= 0,
  );

/** Cut length: the spans summed. */
export const playLength = (spans: readonly Span[]) => spans.reduce((t, p) => t + (p.e - p.s), 0);

/** Play time → footage time. Past the end: the last span's end. */
export function toSource(spans: readonly Span[], t: number): number {
  let at = 0;
  for (const p of spans) {
    const len = p.e - p.s;
    if (t < at + len) return p.s + Math.max(0, t - at);
    at += len;
  }
  return spans.at(-1)?.e ?? 0;
}

/** Footage time → play time, or null when this cut dropped that moment. First span wins on repeats. */
export function toPlay(spans: readonly Span[], src: number): number | null {
  let at = 0;
  for (const p of spans) {
    if (src >= p.s && src < p.e) return at + (src - p.s);
    at += p.e - p.s;
  }
  return null;
}

/** Next footage time this cut plays at or after `src`, or null when none is left. */
export function nextKept(spans: readonly Span[], src: number): number | null {
  let best: number | null = null;
  for (const p of spans) {
    if (src >= p.s && src < p.e) return src;
    if (p.s >= src && (best == null || p.s < best)) best = p.s;
  }
  return best;
}

/** Footage extent over a set of cuts: 0 to the latest kept end. */
export const footageLength = (sources: readonly Source[]) =>
  Math.max(0, ...sources.flatMap((x) => x.spans.map((p) => p.e)));
