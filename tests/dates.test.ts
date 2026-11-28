import { describe, expect, it } from 'vitest';
import { ago, date, dateTime, month, time } from '../src/ui/dates.ts';

// a local time, so the results don't depend on the time zone of the machine
const at = new Date(2026, 10, 21, 15, 19).toISOString();
const plain = (s: string) => s.replace(/\s/g, ' ');
const MIN = 60_000;

describe('dates', () => {
  it('show one format per language, the time of day without a leading zero', () => {
    expect(plain(dateTime(at, 'en-US'))).toBe('Nov 21, 2026, 3:19 PM');
    expect(dateTime(at, 'de-DE')).toBe('21.11.2026, 15:19');
    expect(date(at, 'de-DE')).toBe('21.11.2026');
    expect(month(at, 'en-US')).toBe('Nov 2026');
    expect(month(new Date(2026, 2, 1).toISOString(), 'de-DE')).toBe('März 2026');
    expect(plain(time(at, 'en-US'))).toBe('3:19 PM');
    expect(time(new Date(2026, 10, 21, 9, 5).toISOString(), 'de-DE')).toBe('09:05');
  });

  it('say how long ago, rounded down', () => {
    const now = Date.parse(at);
    expect(ago(at, 'en-US', now + 30_000)).toBe('this minute');
    expect(ago(at, 'en-US', now + 5 * MIN)).toBe('5 minutes ago');
    expect(ago(at, 'de-DE', now + 5 * MIN)).toBe('vor 5 Minuten');
    expect(ago(at, 'en-US', now + 119 * MIN)).toBe('1 hour ago');
    expect(ago(at, 'de-DE', now + 30 * 60 * MIN)).toBe('gestern');
    expect(ago(at, 'en-US', now + 3 * 1440 * MIN)).toBe('3 days ago');
    expect(ago(at, 'en-US', now + 60 * 1440 * MIN)).toBe('2 months ago');
    expect(ago(at, 'en-US', now - 5 * MIN)).toBe('this minute');
  });
});
