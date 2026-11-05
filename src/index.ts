/** Vireo: the variant loop. `vireo({db, collectors, hooks})` is the one entry. */
import { type Ports, Vireo } from "./store.js";

export const vireo = (p: Ports) => new Vireo(p);

export type { Collector, OutcomeRow, Rate, Ship } from "./collect.js";
export { atomic, type Db, type Hooks, type Queryable, type Tx, VireoError } from "./db.js";
export type { Live, LiveRate, LiveRow } from "./live.js";
export * from "./schema.js";
export {
  type BatchRow,
  type Catalog,
  type Feedback,
  type GuideRow,
  guideStats,
  type NewSample,
  type NoteRow,
  type Ports,
  type Queue,
  type SampleRow,
  type ShipRow,
  type SubjectList,
  type SubjectRow,
  strengths,
  Vireo,
} from "./store.js";
export type { Source, Span } from "./sync.js";
