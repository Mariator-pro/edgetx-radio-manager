// Which entries of two model files differ, grouped like the radio's model menus. Values are not shown.

export type DiffArea =
  | 'setup'
  | 'flightModes'
  | 'inputs'
  | 'mixes'
  | 'outputs'
  | 'curves'
  | 'logicalSwitches'
  | 'specialFunctions'
  | 'telemetry'
  | 'customScripts'
  | 'screens';

const DIFF_AREAS: DiffArea[] = [
  'setup',
  'flightModes',
  'inputs',
  'mixes',
  'outputs',
  'curves',
  'logicalSwitches',
  'specialFunctions',
  'telemetry',
  'customScripts',
  'screens',
];

export type DiffKind = 'added' | 'removed' | 'changed';

// Entries without a name on the radio; the interface translates them.
export type DiffTerm = 'name' | 'image' | 'timer' | 'internalModule' | 'externalModule' | 'switchWarnings' | 'otherSettings' | 'screen' | 'topBar';

// Either a name as the radio shows it ("CH2", "SF28–SF40", "RxBt") or a term with an optional number.
export interface DiffEntry {
  kind: DiffKind;
  name?: string;
  term?: DiffTerm;
  n?: number;
}

export interface DiffGroup {
  area: DiffArea;
  entries: DiffEntry[];
}

type Doc = Record<string, unknown>;
type Label = { name: string } | { term: DiffTerm; n?: number };
// One entry's content on each side, keyed by how the radio names it.
type Side = Map<string, { label: Label; parts: Doc }>;

const isObject = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): [number, unknown][] =>
  Array.isArray(v) ? v.map((x, i) => [i, x]) : isObject(v) ? Object.entries(v).map(([k, x]) => [Number(k), x]) : [];
// EdgeTX leaves fields that hold zero out of the file, other tools write them; so a field missing on one side
// matches a zero on the other: 0, empty, or an enum's first value. Values on both sides compare exactly.
const ZERO_NAMES = new Set(['NONE', 'none', 'TYPE_NONE', 'MODE_PER_MODEL', 'OFF', 'GLOBAL']);
const zero = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === 0 ||
  v === '' ||
  v === false ||
  (typeof v === 'string' && ZERO_NAMES.has(v)) ||
  (Array.isArray(v) && v.every(zero)) ||
  (isObject(v) && Object.values(v).every(zero));
const asObject = (v: unknown): Doc | undefined => (Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [i, x])) : isObject(v) ? v : undefined);
function same(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return zero(b);
  if (b === undefined || b === null) return zero(a);
  const x = asObject(a);
  const y = asObject(b);
  if (x && y) return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => same(x[k], y[k]));
  return !x && !y && a === b;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// An entry can gather several parts of the file, each under its own name.
function add(side: Side, key: string, label: Label, value: unknown, part = ''): void {
  const e = side.get(key) ?? { label, parts: {} };
  e.parts[part] = value;
  side.set(key, e);
}

const named = (name: string): Label => ({ name });

// Lines that belong to one channel or input, under its number.
function lines(v: unknown, field: string, label: (n: number) => Label, side: Side): void {
  const count = new Map<number, number>();
  for (const [, line] of list(v)) {
    const n = isObject(line) ? Number(line[field]) || 0 : 0;
    const i = count.get(n) ?? 0;
    count.set(n, i + 1);
    add(side, `${n}`, label(n), line, `line${i}`);
  }
}

// The points of each curve: the file keeps them in one list, each curve after the one before.
function curvePoints(doc: Doc): Map<number, unknown[]> {
  const points = new Map(list(doc.points).map(([i, p]) => [i, isObject(p) ? p.val : p]));
  const out = new Map<number, unknown[]>();
  let at = 0;
  for (const [n, c] of list(doc.curves).sort((x, y) => x[0] - y[0])) {
    const size = 5 + (isObject(c) ? Number(c.points) || 0 : 0);
    const count = isObject(c) && Number(c.type) === 1 ? size * 2 - 2 : size;
    out.set(n, Array.from({ length: count }, (_, i) => points.get(at + i) ?? 0));
    at += count;
  }
  return out;
}

function sides(doc: Doc): Map<DiffArea, Side> {
  const areas = new Map<DiffArea, Side>(DIFF_AREAS.map((a) => [a, new Map()]));
  const area = (a: DiffArea) => areas.get(a)!;
  const inputNames = new Map(list(doc.inputNames).map(([n, x]) => [n, isObject(x) ? str(x.val) : '']));
  const points = curvePoints(doc);
  const sensors = new Map<string, number>();

  for (const [key, value] of Object.entries(doc)) {
    switch (key) {
      case 'semver':
      case 'view':
        break; // the EdgeTX version that saved the file, the screen last shown
      case 'header':
        for (const [k, v] of Object.entries(isObject(value) ? value : {})) {
          if (k === 'name') add(area('setup'), 'name', { term: 'name' }, v);
          else if (k === 'bitmap') add(area('setup'), 'image', { term: 'image' }, v);
          else add(area('setup'), 'other', { term: 'otherSettings' }, v, `header.${k}`);
        }
        break;
      case 'timers':
        for (const [n, v] of list(value)) add(area('setup'), `timer${n}`, { term: 'timer', n: n + 1 }, v);
        break;
      case 'moduleData':
        for (const [n, v] of list(value)) {
          const label: Label = n === 0 ? { term: 'internalModule' } : n === 1 ? { term: 'externalModule' } : named(`Module ${n}`);
          add(area('setup'), `module${n}`, label, v);
        }
        break;
      case 'customSwitches':
        for (const [k, v] of Object.entries(isObject(value) ? value : {})) add(area('setup'), k, named(k), v);
        break;
      case 'switchWarning':
        add(area('setup'), 'switchWarnings', { term: 'switchWarnings' }, value);
        break;
      case 'flightModeData':
        for (const [n, v] of list(value)) add(area('flightModes'), `${n}`, named(`FM${n}`), v);
        break;
      case 'expoData':
        lines(value, 'chn', (n) => named(inputNames.get(n) || `I${n + 1}`), area('inputs'));
        break;
      case 'inputNames':
        for (const [n, v] of list(value)) add(area('inputs'), `${n}`, named(inputNames.get(n) || `I${n + 1}`), v, 'name');
        break;
      case 'mixData':
        lines(value, 'destCh', (n) => named(`CH${n + 1}`), area('mixes'));
        break;
      case 'limitData':
        for (const [n, v] of list(value)) add(area('outputs'), `${n}`, named(`CH${n + 1}`), v);
        break;
      case 'curves':
        for (const [n, v] of list(value)) add(area('curves'), `${n}`, named((isObject(v) && str(v.name)) || `CV${n + 1}`), [v, points.get(n)]);
        break;
      case 'points':
        break; // with their curve
      case 'logicalSw':
        for (const [n, v] of list(value)) add(area('logicalSwitches'), `${n}`, named(`L${n + 1}`), v);
        break;
      case 'customFn':
        for (const [n, v] of list(value)) add(area('specialFunctions'), `${n}`, named(`SF${n + 1}`), v);
        break;
      case 'telemetrySensors':
        // by name, so one inserted sensor doesn't shift all that follow
        for (const [n, v] of list(value)) {
          const base = (isObject(v) && str(v.label)) || `Sensor ${n + 1}`;
          const seen = (sensors.get(base) ?? 0) + 1;
          sensors.set(base, seen);
          const name = seen > 1 ? `${base} (${seen})` : base;
          add(area('telemetry'), name, named(name), v);
        }
        break;
      case 'scriptsData':
        for (const [n, v] of list(value)) add(area('customScripts'), `${n}`, named((isObject(v) && str(v.file)) || `LUA${n + 1}`), v);
        break;
      case 'screenData':
        for (const [n, v] of list(value)) add(area('screens'), `${n}`, { term: 'screen', n: n + 1 }, v);
        break;
      case 'topbarData':
      case 'topbarWidgetWidth':
        add(area('screens'), 'topBar', { term: 'topBar' }, value, key);
        break;
      default:
        add(area('setup'), 'other', { term: 'otherSettings' }, value, key);
    }
  }
  return areas;
}

// An empty entry (no lines, a slot with nothing set) counts as missing.
const empty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.every(empty)) || (isObject(v) && Object.values(v).every(empty));

const SERIES = /^(.*?)(\d+)$/;

// "SF28", "SF29", "SF30" become "SF28–SF30"; two in a row stay apart.
function compact(entries: DiffEntry[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (let i = 0; i < entries.length; ) {
    const e = entries[i]!;
    const m = e.name?.match(SERIES);
    let j = i + 1;
    if (m) {
      while (j < entries.length) {
        const next = entries[j]!.name?.match(SERIES);
        if (!next || next[1] !== m[1] || Number(next[2]) !== Number(m[2]) + (j - i)) break;
        j++;
      }
    }
    if (j - i >= 3) {
      out.push({ kind: e.kind, name: `${e.name}–${entries[j - 1]!.name}` });
      i = j;
    } else {
      out.push(e);
      i++;
    }
  }
  return out;
}

const KINDS: DiffKind[] = ['added', 'removed', 'changed'];

export function diffModels(a: Doc, b: Doc): DiffGroup[] {
  const left = sides(a);
  const right = sides(b);
  const groups: DiffGroup[] = [];
  for (const area of DIFF_AREAS) {
    const x = left.get(area)!;
    const y = right.get(area)!;
    const found: DiffEntry[] = [];
    for (const key of [...new Set([...x.keys(), ...y.keys()])]) {
      const from = x.get(key);
      const to = y.get(key);
      const had = from && !empty(from.parts);
      const has = to && !empty(to.parts);
      // an entry on one side only that holds nothing but zeros is what the other side leaves out
      const kind: DiffKind | undefined =
        had && has ? (same(from.parts, to.parts) ? undefined : 'changed') : had ? (zero(from.parts) ? undefined : 'removed') : has && !zero(to.parts) ? 'added' : undefined;
      if (kind) found.push({ kind, ...(to ?? from)!.label });
    }
    const entries = KINDS.flatMap((kind) => compact(found.filter((e) => e.kind === kind)));
    if (entries.length > 0) groups.push({ area, entries });
  }
  return groups;
}
