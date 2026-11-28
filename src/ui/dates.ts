import { useEffect, useState } from 'react';

// The one date and time format of the app, in the interface language (locale like "en-US" or "de-DE").
// Point in time: "Nov 21, 2026, 3:19 PM" / "21.11.2026, 15:19"; day: "Nov 21, 2026" / "21.11.2026";
// month: "Mar 2026" / "März 2026"; time of day: "3:19 PM" / "15:19"; how long ago: "5 minutes ago" / "vor 5 Minuten".

export function dateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function date(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

// A month without the day: "Mar 2026" / "März 2026".
export function month(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', year: 'numeric' });
}

export function time(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { timeStyle: 'short' });
}

// Steps of `ago`: below the limit (in seconds) the time is counted in this unit.
const STEPS: [limit: number, unit: Intl.RelativeTimeFormatUnit, size: number][] = [
  [3600, 'minute', 60],
  [86_400, 'hour', 3600],
  [30 * 86_400, 'day', 86_400],
  [365 * 86_400, 'month', 30 * 86_400],
  [Infinity, 'year', 365 * 86_400],
];

// How long ago, rounded down: "this minute", "5 minutes ago", "yesterday", "3 days ago". A time in the
// future (clocks that differ a little) counts as now. Show `dateTime` as its tooltip.
export function ago(iso: string, locale: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  const [, unit, size] = STEPS.find(([limit]) => seconds < limit)!;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
}

// The current time, renewed every minute, so texts made with `ago` stay right on a page left open.
export function useNow(every = 60_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}
