// Line differences between two text files, for a conflict in the SD update: the file on the card and the new one.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'skip'; n: number };

// Above this many line pairs the comparison table gets too big; the caller says the file is too large.
const MAX_CELLS = 4_000_000;
// Unchanged lines kept around each change; longer unchanged stretches become one "skip".
const CONTEXT = 3;

// A NUL byte in the first 8 KB: not a text file.
export function isText(data: Uint8Array): boolean {
  return !data.subarray(0, 8192).includes(0);
}

const linesOf = (text: string) => (text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

// From `before` to `after`, unchanged stretches folded to CONTEXT lines around each change.
// undefined when the files are too large to compare.
export function lineDiff(before: string, after: string): DiffLine[] | undefined {
  const a = linesOf(before);
  const b = linesOf(after);
  // common start and end first, so a small change in a long file stays cheap
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) return undefined;

  // longest common subsequence, filled from the end
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const all: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      all.push({ kind: 'same', text: x[i++]! });
      j++;
    } else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      // removed lines before the added ones that replace them
      all.push({ kind: 'del', text: x[i++]! });
    } else {
      all.push({ kind: 'add', text: y[j++]! });
    }
  }
  for (const text of a.slice(a.length - end)) all.push({ kind: 'same', text });
  return fold(all);
}

function fold(lines: DiffLine[]): DiffLine[] {
  const changed = lines.map((l) => l.kind !== 'same');
  const near = (k: number) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (changed[k + d]) return true;
    return false;
  };
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, k) => {
    if (l.kind !== 'same' || near(k)) {
      if (skipped) out.push({ kind: 'skip', n: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', n: skipped });
  return out;
}
