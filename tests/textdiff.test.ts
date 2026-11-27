import { describe, expect, it } from 'vitest';
import { isText, lineDiff } from '../src/core/textdiff.ts';

describe('lineDiff', () => {
  it('marks removed and added lines and keeps the unchanged ones around them', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
  });

  it('folds long unchanged stretches to three lines around each change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i === 10 ? 'changed' : l));
    const d = lineDiff(before.join('\n'), after.join('\r\n'))!;
    expect(d[0]).toEqual({ kind: 'skip', n: 7 });
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(6);
    expect(d.at(-1)).toEqual({ kind: 'skip', n: 6 });
  });

  it('shows a whole file as added or removed when the other side is empty', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'del', text: 'x' }]);
  });

  it('gives up on files too large to compare and tells binary files apart', () => {
    const big = (c: string) => Array.from({ length: 3000 }, (_, i) => `${c}${i}`).join('\n');
    expect(lineDiff(big('a'), big('b'))).toBeUndefined();
    expect(isText(Buffer.from('local x = 1\n'))).toBe(true);
    expect(isText(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(false);
  });
});
