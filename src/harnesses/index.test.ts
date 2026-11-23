import { describe, expect, test } from "bun:test";
import { parseHarnessSelection } from "./index";

describe("harness selection", () => {
  test("resolves defaults and 'all'", () => {
    expect(parseHarnessSelection(undefined, ["needle-compatible", "agent"])).toEqual([
      "needle-compatible",
      "agent",
    ]);
    expect(parseHarnessSelection("all", ["needle-compatible"])).toEqual(["needle-compatible"]);
  });

  test("selects individual harnesses independently", () => {
    expect(parseHarnessSelection("agent", ["needle-compatible"])).toEqual(["agent"]);
    expect(parseHarnessSelection("needle-compatible", ["needle-compatible", "agent"])).toEqual(["needle-compatible"]);
  });

  test("opts into the pair independently of scheduled defaults", () => {
    expect(parseHarnessSelection("both", ["needle-compatible"])).toEqual(["needle-compatible", "agent"]);
  });

  test("rejects unknown harness names", () => {
    expect(() => parseHarnessSelection("invalid-harness", ["needle-compatible"])).toThrow();
  });
});
