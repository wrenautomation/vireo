import { describe, expect, it } from "vitest";
import { footageLength, isSource, nextKept, playLength, toPlay, toSource } from "./sync.js";

// footage 0-10; cut keeps 0-2, 5-8 (drops 2-5 and 8-10)
const cut = [
  { s: 0, e: 2 },
  { s: 5, e: 8 },
];

describe("sync maps", () => {
  it("maps play time to footage time across a cut", () => {
    expect(toSource(cut, 1)).toBe(1);
    expect(toSource(cut, 2)).toBe(5);
    expect(toSource(cut, 3.5)).toBe(6.5);
    expect(toSource(cut, 99)).toBe(8);
  });

  it("maps footage time back, null where the cut dropped it", () => {
    expect(toPlay(cut, 1)).toBe(1);
    expect(toPlay(cut, 6.5)).toBe(3.5);
    expect(toPlay(cut, 3)).toBeNull();
    expect(toPlay(cut, 9)).toBeNull();
  });

  it("round-trips every kept moment", () => {
    for (const t of [0, 0.5, 1.99, 2, 4.9]) expect(toPlay(cut, toSource(cut, t))).toBeCloseTo(t);
  });

  it("finds the next kept moment", () => {
    expect(nextKept(cut, 3)).toBe(5);
    expect(nextKept(cut, 6)).toBe(6);
    expect(nextKept(cut, 9)).toBeNull();
  });

  it("handles reordered spans (a cold open)", () => {
    const open = [
      { s: 6, e: 7 },
      { s: 0, e: 2 },
    ];
    expect(toSource(open, 0.5)).toBe(6.5);
    expect(toPlay(open, 1)).toBe(2);
    expect(playLength(open)).toBe(3);
  });

  it("checks a source and its extent", () => {
    expect(isSource({ ref: "studio:1", spans: cut })).toBe(true);
    expect(isSource({ ref: "studio:1", spans: [{ s: 2, e: 1 }] })).toBe(false);
    expect(footageLength([{ ref: "a", spans: cut }])).toBe(8);
  });
});
