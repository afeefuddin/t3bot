import type { BotSchedule } from "@t3tools/contracts/bot";

export function validateSchedule(schedule: BotSchedule): void {
  if (schedule.type === "daily") {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
      schedule.weekdays.length === 0 ||
      schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      throw new Error("Invalid daily schedule");
    new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(0);
  }
  if (schedule.type === "once" && !Number.isFinite(schedule.at))
    throw new Error("Invalid reminder time");
}

export function nextWake(schedule: BotSchedule, after: number): number | null {
  switch (schedule.type) {
    case "once":
      return schedule.at > after ? schedule.at : null;
    case "interval":
      return after + schedule.everyMs;
    case "event":
      return null;
    case "daily": {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: schedule.timezone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const parts = (at: number) =>
        Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
      const initial = parts(after);
      const initialDate = `${initial.year}-${initial.month}-${initial.day}`;
      const initialTime = `${initial.hour}:${initial.minute}`;
      // Walk real UTC minutes: a repeated local hour fires once; a missing local time fires at the first valid minute after it.
      for (
        let at = Math.floor(after / 60000) * 60000 + 60000;
        at < after + 9 * 86400000;
        at += 60000
      ) {
        const p = parts(at);
        const date = `${p.year}-${p.month}-${p.day}`;
        const time = `${p.hour}:${p.minute}`;
        if (date === initialDate && initialTime >= schedule.time) continue;
        if (schedule.weekdays.includes(weekdays.indexOf(p.weekday ?? "")) && time >= schedule.time)
          return at;
      }
      throw new Error("No future schedule occurrence");
    }
  }
}
