/** A person's call, pure (no drizzle): hosts' browsers import it (`./calls`). D9. */

/** The call on a whole sample, best first: a zone of the 1-10 score. */
export const VERDICTS = ["amazing", "good", "okay", "bad"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Lowest score of each zone: 9-10 amazing, 7-8 good, 4-6 okay, 1-3 bad. */
export const ZONE_FLOOR = { amazing: 9, good: 7, okay: 4, bad: 1 } as const satisfies Record<
  Verdict,
  number
>;
/** The score a plain call (a tap, `judge 3 good`) sets. */
export const TAP = { amazing: 9, good: 7, okay: 5, bad: 2 } as const satisfies Record<
  Verdict,
  number
>;
export const verdictOf = (score: number): Verdict =>
  VERDICTS.find((v) => score >= ZONE_FLOOR[v]) ?? "bad";
