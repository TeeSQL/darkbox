const NY_TIME_ZONE = "America/New_York";
const SUNDAY = 0;

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const weekdayIndexes: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone = NY_TIME_ZONE): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayIndexes[get("weekday")] ?? 0,
  };
}

function zonedDateTimeToUtc(parts: Omit<ZonedParts, "weekday">, timeZone = NY_TIME_ZONE): Date {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const actualAtGuess = zonedParts(new Date(utcGuess), timeZone);
  const zonedAsUtc = Date.UTC(
    actualAtGuess.year,
    actualAtGuess.month - 1,
    actualAtGuess.day,
    actualAtGuess.hour,
    actualAtGuess.minute,
    actualAtGuess.second,
  );
  return new Date(utcGuess - (zonedAsUtc - utcGuess));
}

export function defaultMarketCloseTimeSeconds(now = new Date()): number {
  const localNow = zonedParts(now);
  let daysUntilSunday = (SUNDAY - localNow.weekday + 7) % 7;
  let target = zonedDateTimeToUtc({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + daysUntilSunday,
    hour: 17,
    minute: 0,
    second: 0,
  });
  if (target.getTime() <= now.getTime()) {
    daysUntilSunday += 7;
    target = zonedDateTimeToUtc({
      year: localNow.year,
      month: localNow.month,
      day: localNow.day + daysUntilSunday,
      hour: 17,
      minute: 0,
      second: 0,
    });
  }
  return Math.floor(target.getTime() / 1000);
}

export function parseMarketCloseTimeSeconds(value: unknown, now = new Date()): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return defaultMarketCloseTimeSeconds(now);
}
