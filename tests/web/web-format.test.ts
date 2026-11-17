import { describe, expect, it } from "vitest";

import { formatRatio } from "../../web/src/lib/format.js";

describe("web metric formatting", () => {
  it("renders an empty denominator as a Chinese no-data label", () => {
    expect(formatRatio(0, 0)).toBe("暂无");
  });

  it("renders real ratios without conflating zero success and no data", () => {
    expect(formatRatio(0, 4)).toBe("0%");
    expect(formatRatio(3, 4)).toBe("75%");
  });
});
