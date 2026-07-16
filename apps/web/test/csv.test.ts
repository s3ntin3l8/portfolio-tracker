import { describe, it, expect } from "vitest";
import { toCsv } from "../src/lib/csv";

describe("toCsv", () => {
  it("joins a header row and data rows with newlines", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          [1, 2],
          ["x", "y"],
        ],
      ),
    ).toBe("a,b\n1,2\nx,y");
  });

  it("quotes values containing commas, quotes or newlines (doubling quotes)", () => {
    expect(toCsv(["name"], [["a,b"], ['he said "hi"'], ["line\nbreak"]])).toBe(
      'name\n"a,b"\n"he said ""hi"""\n"line\nbreak"',
    );
  });

  it("returns just the header for no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b");
  });
});
