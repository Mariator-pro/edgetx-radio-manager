// Differences between two model files, grouped like the radio's model menus.
// Headings are translated by the interface; the entries name the file's keys and stay English.

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
  | 'screens'
  | 'other';

export const DIFF_AREAS: DiffArea[] = [
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
  'other',
];

const AREA_OF: Record<string, DiffArea> = {
  header: 'setup',
  semver: 'setup',
  timers: 'setup',
  moduleData: 'setup',
  switchWarning: 'setup',
  customSwitches: 'setup',
  cfsGroupOn: 'setup',
  flightModeData: 'flightModes',
  expoData: 'inputs',
  inputNames: 'inputs',
  mixData: 'mixes',
  limitData: 'outputs',
  curves: 'curves',
  points: 'curves',
  logicalSw: 'logicalSwitches',
  customFn: 'specialFunctions',
  telemetrySensors: 'telemetry',
  scriptsData: 'customScripts',
  screenData: 'screens',
  topbarData: 'screens',
  topbarWidgetWidth: 'screens',
  view: 'screens',
};

export interface DiffEntry {
  path: string; // e.g. "Mix CH2, line 3 › weight"
  from?: string; // missing: added
  to?: string; // missing: removed
}

export interface DiffGroup {
  area: DiffArea;
  entries: DiffEntry[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLeaf = (v: unknown) => !isObject(v) && !Array.isArray(v);
const text = (v: unknown) => (v === null || v === undefined ? '' : isLeaf(v) ? String(v) : JSON.stringify(v));
const num = (k: string) => (/^\d+$/.test(k) ? parseInt(k, 10) : NaN);

// Names like the radio shows them for numbered entries; other keys stay as they are.
const LABELS: Record<string, (n: number) => string> = {
  customFn: (n) => `SF${n + 1}`,
  logicalSw: (n) => `L${n + 1}`,
  limitData: (n) => `CH${n + 1}`,
  flightModeData: (n) => `FM${n}`,
  timers: (n) => `Timer ${n + 1}`,
  telemetrySensors: (n) => `Sensor ${n + 1}`,
  curves: (n) => `Curve ${n + 1}`,
  scriptsData: (n) => `Script ${n + 1}`,
  screenData: (n) => `Screen ${n + 1}`,
  inputNames: (n) => `Input ${n + 1}`,
  moduleData: (n) => (n === 0 ? 'Internal module' : n === 1 ? 'External module' : `Module ${n}`),
};

function walk(a: unknown, b: unknown, path: string[], out: DiffEntry[]): void {
  if (isLeaf(a) && isLeaf(b)) {
    if (text(a) !== text(b)) out.push({ path: path.join(' › '), ...(a !== undefined ? { from: text(a) } : {}), ...(b !== undefined ? { to: text(b) } : {}) });
    return;
  }
  if (a === undefined || b === undefined) {
    out.push({ path: path.join(' › '), ...(a !== undefined ? { from: summary(a) } : {}), ...(b !== undefined ? { to: summary(b) } : {}) });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], [...path, String(i + 1)], out);
    return;
  }
  const x = isObject(a) ? a : {};
  const y = isObject(b) ? b : {};
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort((k, l) => (num(k) - num(l)) || k.localeCompare(l));
  const parent = path.length === 1 ? path[0] : undefined;
  for (const k of keys) {
    const label = parent && LABELS[parent] && !Number.isNaN(num(k)) ? LABELS[parent]!(num(k)) : k;
    walk(x[k], y[k], parent && LABELS[parent] && label !== k ? [label] : [...path, label], out);
  }
}

// One line for a whole entry that is only on one side.
function summary(v: unknown): string {
  if (isLeaf(v)) return text(v);
  if (isObject(v)) {
    const name = v.name ?? v.label ?? v.func ?? v.LayoutId;
    return name !== undefined && name !== '' ? String(name) : '…';
  }
  return '…';
}

// Mixes by channel, each channel's lines in order, so one inserted mix shifts only its own channel.
function mixes(a: unknown, b: unknown, out: DiffEntry[]): void {
  const byChannel = (v: unknown) => {
    const m = new Map<number, unknown[]>();
    for (const line of Array.isArray(v) ? v : []) {
      const ch = isObject(line) ? Number(line.destCh) || 0 : 0;
      m.set(ch, [...(m.get(ch) ?? []), line]);
    }
    return m;
  };
  const x = byChannel(a);
  const y = byChannel(b);
  for (const ch of [...new Set([...x.keys(), ...y.keys()])].sort((p, q) => p - q)) {
    const l = x.get(ch) ?? [];
    const r = y.get(ch) ?? [];
    for (let i = 0; i < Math.max(l.length, r.length); i++) walk(l[i], r[i], [`Mix CH${ch + 1}, line ${i + 1}`], out);
  }
}

// Inputs by their input number, like the radio lists them.
function inputs(a: unknown, b: unknown, out: DiffEntry[]): void {
  const byInput = (v: unknown) => {
    const m = new Map<number, unknown[]>();
    for (const line of Array.isArray(v) ? v : []) {
      const ch = isObject(line) ? Number(line.chn) || 0 : 0;
      m.set(ch, [...(m.get(ch) ?? []), line]);
    }
    return m;
  };
  const x = byInput(a);
  const y = byInput(b);
  for (const ch of [...new Set([...x.keys(), ...y.keys()])].sort((p, q) => p - q)) {
    const l = x.get(ch) ?? [];
    const r = y.get(ch) ?? [];
    for (let i = 0; i < Math.max(l.length, r.length); i++) walk(l[i], r[i], [`Input ${ch + 1}, line ${i + 1}`], out);
  }
}

export function diffModels(a: Record<string, unknown>, b: Record<string, unknown>): DiffGroup[] {
  const groups = new Map<DiffArea, DiffEntry[]>();
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const area = AREA_OF[k] ?? (isLeaf(a[k]) && isLeaf(b[k]) ? 'setup' : 'other');
    const out = groups.get(area) ?? [];
    if (k === 'mixData') mixes(a[k], b[k], out);
    else if (k === 'expoData') inputs(a[k], b[k], out);
    else walk(a[k], b[k], [k], out);
    groups.set(area, out);
  }
  return DIFF_AREAS.filter((area) => (groups.get(area)?.length ?? 0) > 0).map((area) => ({ area, entries: groups.get(area)! }));
}
