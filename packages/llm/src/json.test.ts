import { describe, expect, it } from "vitest";
import { extractJson } from "./json.ts";

describe("extractJson", () => {
  it("reads plain JSON, a ```json block and an object surrounded by text", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here it is:\n```json\n{"a":2}\n```\nend')).toEqual({ a: 2 });
    expect(extractJson('Answer: {"a":"}{","b":{"c":3}} thanks')).toEqual({ a: "}{", b: { c: 3 } });
  });
  it("returns undefined if there is no JSON", () => {
    expect(extractJson("no json")).toBeUndefined();
  });
});
