import { describe, expect, it } from "vite-plus/test";
import { nextWake, validateSchedule } from "./schedule.ts";

describe("responsibility wall-clock scheduling", () => {
  it("fires once through a repeated DST hour", () => {
    const schedule = {
      type: "daily" as const,
      time: "01:30",
      timezone: "America/New_York",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    };
    const first = nextWake(schedule, Date.parse("2026-11-01T04:00:00Z"));
    expect(first).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(nextWake(schedule, first!)).toBe(Date.parse("2026-11-02T06:30:00Z"));
  });
  it("uses the first valid minute after a missing DST wall time", () => {
    expect(
      nextWake(
        {
          type: "daily",
          time: "02:30",
          timezone: "America/New_York",
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
        Date.parse("2026-03-08T05:00:00Z"),
      ),
    ).toBe(Date.parse("2026-03-08T07:00:00Z"));
  });
  it("rejects invalid timezones and weekdays", () => {
    expect(() =>
      validateSchedule({ type: "daily", time: "25:00", timezone: "Nowhere", weekdays: [9] }),
    ).toThrow();
  });
});
