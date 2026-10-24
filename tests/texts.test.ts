import { describe, expect, it } from 'vitest';
import { LANGUAGES, TEXTS } from '../src/ui/texts.ts';

// Calls every text with sample values, so each language's shape can be compared with English.
function sample(v: unknown): unknown {
  if (typeof v === 'function') return typeof v(1, 1, 1, 'x');
  if (Array.isArray(v)) return v.map(sample);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sample(x)]));
  return typeof v;
}

describe('interface texts', () => {
  it('has one text set per menu entry', () => {
    expect(Object.keys(TEXTS).sort()).toEqual(LANGUAGES.map((l) => l.id).sort());
  });

  it.each(LANGUAGES.map((l) => l.id))('%s has every text of English, with the same number of steps', (id) => {
    expect(sample(TEXTS[id])).toEqual(sample(TEXTS.en));
  });

  it('picks the plural that fits the number', () => {
    expect(TEXTS.ru.backupCount(1)).toBe('1 копия');
    expect(TEXTS.ru.backupCount(3)).toBe('3 копии');
    expect(TEXTS.ru.backupCount(11)).toBe('11 копий');
    expect(TEXTS.ru.backupCount(22)).toBe('22 копии');
    expect(TEXTS.cs.backupCount(5)).toBe('5 záloh');
  });
});
