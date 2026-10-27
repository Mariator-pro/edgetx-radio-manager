import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupCard } from '../src/core/backup.ts';
import { diffModels } from '../src/core/modeldiff.ts';
import {
  applyCopy,
  applyDelete,
  backupOrigin,
  cardStatus,
  controlsUsed,
  exportName,
  modelEntries,
  parseHardware,
  parseModel,
  planCopy,
  planDelete,
  readCardState,
  readImport,
  widgetName,
} from '../src/core/models.ts';
import { paths } from '../src/core/paths.ts';
import { parseRadioTypes } from '../src/core/radios.ts';
import { readZipBuffer } from '../src/core/zip.ts';
import { makeZip, SDCARD_JSON, tempDir, writeTree } from './helpers.ts';

const TX15_RADIO = `semver: 2.12.5
board: tx15
ttsLanguage: "en"
internalModule: TYPE_CROSSFIRE
currModelFilename: "model2.yml"
switchConfig:
   SA:
      type: 3POS
   SB:
      type: 3POS
   SW1:
      type: 2POS
potsConfig:
   P1:
      type: with_detent
`;

const MK3_RADIO = `semver: 2.12.5
board: tx16smk3
ttsLanguage: "en"
internalModule: TYPE_CROSSFIRE
switchConfig:
   SA:
      type: 3POS
   SB:
      type: 3POS
   SG:
      type: 3POS
   SI:
      type: NONE
   SW1:
      type: 2POS
potsConfig:
   P1:
      type: with_detent
   SL1:
      type: slider
`;

// A model file as EdgeTX writes it, cut down to what the tool reads.
function model(name: string, o: { labels?: string; bitmap?: string; semver?: string; id?: number; switches?: string[]; weight?: number; extra?: string } = {}): string {
  const sw = (o.switches ?? ['SA0']).map((s) => ` -\n   destCh: 0\n   srcRaw: "I0"\n   swtch: "${s}"\n   weight: ${o.weight ?? 100}\n`).join('');
  return `semver: ${o.semver ?? '2.12.5'}
header:
   name: "${name}"
   modelId:
      0:
         val: ${o.id ?? 1}
   bitmap: "${o.bitmap ?? ''}"
   labels: "${o.labels ?? ''}"
mixData:
${sw}moduleData:
   0:
      type: TYPE_CROSSFIRE
${o.extra ?? ''}`;
}

const at = (h: number) => new Date(2026, 9, 21, h, 0);

describe('reading models', () => {
  it('reads name, labels, image and version, and only model<digits>.yml', async () => {
    const card = await tempDir();
    await writeTree(card, {
      'MODELS/model2.yml': model('Master Copter', { labels: 'Copter,Fav/cs,Heli//c', bitmap: 'mc.png', semver: '2.12.1' }),
      'MODELS/model4.yml': model(''),
      'MODELS/labels.yml': 'Labels:\n',
      'MODELS/README.txt': 'x',
    });
    const state = await readCardState(card);
    expect(state.models.map((m) => [m.file, m.name])).toEqual([
      ['model2.yml', 'Master Copter'],
      ['model4.yml', 'model4'],
    ]);
    expect(state.models[0]).toMatchObject({ bitmap: 'mc.png', labels: ['Copter', 'Fav,s', 'Heli/c'], semver: '2.12.1' });
  });

  it('reads the fitted controls, module, language and loaded model from radio.yml', () => {
    expect(parseHardware(MK3_RADIO)).toEqual({
      board: 'tx16smk3',
      firmware: '2.12.5',
      language: 'en',
      controls: ['SA', 'SB', 'SG', 'SW1', 'P1', 'SL1'],
      internalModule: 'TYPE_CROSSFIRE',
    });
    expect(parseHardware(TX15_RADIO).currentModel).toBe('model2.yml');
    expect(parseHardware(undefined)).toEqual({ controls: [] });
  });

  it('finds the controls a model uses, with switch positions', () => {
    const m = parseModel('model1.yml', Buffer.from(model('X', { switches: ['SA0', '!SG2', 'SW12', 'NONE', 'L1'] })));
    expect(controlsUsed(m, ['SA', 'SG', 'SW1', 'P1'])).toEqual(['SA', 'SG', 'SW1']);
    expect(controlsUsed(m)).toEqual(['SA', 'SG', 'SW1']);
  });

  it('reads widget names written directly or through a variable', () => {
    expect(widgetName('return { name = "Ghost", create = c }')).toBe('Ghost');
    expect(widgetName('local app_name = "Flights"\nreturn {name=app_name, options=o}')).toBe('Flights');
    expect(widgetName('return { create = c }')).toBeUndefined();
  });
});

describe('models across backups', () => {
  it('groups by name, one version per content, newest first with the oldest backup since', async () => {
    const card = await tempDir();
    const p = paths(await tempDir());
    await writeTree(card, { 'RADIO/radio.yml': TX15_RADIO, 'MODELS/model1.yml': model('Copter', { weight: 100 }) });
    const b1 = await backupCard(card, 'tx15', p, at(10));
    const b2 = await backupCard(card, 'tx15', p, at(11));
    await writeTree(card, { 'MODELS/model1.yml': model('Copter', { weight: 80 }), 'MODELS/model2.yml': model('Copter') });
    const b3 = await backupCard(card, 'tx15', p, at(12));
    const entries = await modelEntries(p, 'tx15');
    expect(entries.map((e) => [e.name, e.file])).toEqual([
      ['Copter', undefined],
      ['Copter', 'model1.yml'],
      ['Copter', 'model2.yml'],
    ]);
    const single = entries.find((e) => !e.file)!;
    expect(single.versions.map((v) => [v.backup, v.since])).toEqual([[b2.name, b1.name]]);
    expect(entries[1]!.versions.map((v) => v.backup)).toEqual([b3.name]);
  });

  it('counts "since" back only while the content stayed, not across another version', async () => {
    const card = await tempDir();
    const p = paths(await tempDir());
    await writeTree(card, { 'RADIO/radio.yml': TX15_RADIO, 'MODELS/model1.yml': model('Copter', { weight: 100 }) });
    await backupCard(card, 'tx15', p, at(10));
    await writeTree(card, { 'MODELS/model1.yml': model('Copter', { weight: 80 }) });
    const b2 = await backupCard(card, 'tx15', p, at(11));
    await writeTree(card, { 'MODELS/model1.yml': model('Copter', { weight: 100 }) });
    const b3 = await backupCard(card, 'tx15', p, at(12));
    const b4 = await backupCard(card, 'tx15', p, at(13));
    const [entry] = await modelEntries(p, 'tx15');
    expect(entry!.versions.map((v) => [v.backup, v.since])).toEqual([
      [b4.name, b3.name],
      [b2.name, b2.name],
    ]);
  });

  it('compares with the model of the same name on the card', async () => {
    const card = await tempDir();
    const p = paths(await tempDir());
    await writeTree(card, { 'RADIO/radio.yml': TX15_RADIO, 'MODELS/model1.yml': model('A', { weight: 1 }), 'MODELS/model2.yml': model('B') });
    await backupCard(card, 'tx15', p, at(10));
    await writeTree(card, { 'MODELS/model1.yml': model('A', { weight: 2 }) });
    await backupCard(card, 'tx15', p, at(11));
    await writeTree(card, { 'MODELS/model1.yml': model('A', { weight: 1 }) });
    await rm(join(card, 'MODELS/model2.yml'));
    const state = await readCardState(card);
    const [a, b] = await modelEntries(p, 'tx15');
    expect(cardStatus(a!, state.models)).toEqual({ status: 'changed', version: 1 });
    expect(cardStatus(b!, state.models)).toEqual({ status: 'missing' });
  });
});

describe('copying models', () => {
  async function setup() {
    const p = paths(await tempDir());
    const types = parseRadioTypes(SDCARD_JSON);
    // the Mk III with its model, image, checklist, a mix script and a widget from a package
    const mk3 = await tempDir();
    await writeTree(mk3, {
      'RADIO/radio.yml': MK3_RADIO,
      'MODELS/model1.yml': model('Master Copter', {
        bitmap: 'mc.png',
        id: 6,
        switches: ['SA0', 'SG2', 'SL1'],
        extra:
          'scriptsData: \n   0:\n      file: "wobble"\ncustomFn: \n   0:\n      swtch: "ON"\n      func: PLAY_TRACK\n      def: "armed,1,!1x"\nscreenData: \n   0:\n      layoutData: \n         zones: \n            0:\n               widgetName: Sentinel\n            1:\n               widgetName: ModelBmp\n',
      }),
      'MODELS/Master Copter.txt': 'check the props',
      'IMAGES/mc.png': 'mk3 picture',
      'SCRIPTS/MIXES/wobble.lua': 'return {}',
      'SOUNDS/en/armed.wav': 'x',
      'WIDGETS/SENTINEL/main.lua': 'local name = "Sentinel"\nreturn { name = name }',
      '.radio-manager/installed.json': JSON.stringify({
        tool: 1,
        updated: '',
        packages: {},
        files: { 'WIDGETS/SENTINEL/main.lua': { sha256: 'x', from: ['link-sentinel'], written: 'link-sentinel' } },
      }),
    });
    const b = await backupCard(mk3, 'tx16smk3', p, at(10));
    // the TX15 with another model in slot 1 and an older Master Copter in slot 2
    const tx15 = await tempDir();
    await writeTree(tx15, {
      'RADIO/radio.yml': TX15_RADIO,
      'MODELS/model1.yml': model('Glider', { id: 6 }),
      'MODELS/model2.yml': model('Master Copter', { id: 6 }),
      'IMAGES/mc.png': 'tx15 picture',
    });
    return { p, types, b, tx15 };
  }

  it('replaces the model of the same name, brings image and checklist, and names what does not fit', async () => {
    const { p, types, b, tx15 } = await setup();
    const origin = await backupOrigin(p, 'tx16smk3', b.name);
    const m = (await readCardState(join(p.backups, 'tx16smk3', b.name))).models[0]!;
    const card = await readCardState(tx15);
    const [item] = await planCopy(card, [{ model: m, origin }], types);
    expect(item).toMatchObject({ mode: 'replace', canReplace: true, target: 'model2.yml', controls: ['SG', 'SL1'], screen: { model: '800x480', radio: '480x320' } });
    expect(item!.image).toMatchObject({ path: 'IMAGES/mc.png', action: 'replace' });
    expect(item!.checklist).toMatchObject({ path: 'MODELS/Master Copter.txt', action: 'add' });
    expect(item!.missing).toEqual([
      { path: 'SCRIPTS/MIXES/wobble.lua' },
      { path: 'SOUNDS/en/armed.wav' },
      { path: 'WIDGETS/SENTINEL/', pkg: 'link-sentinel' },
    ]);
    expect(item!.receiver).toEqual({ id: 6, models: ['Glider'] });
    expect(item!.module).toBeUndefined();

    const before = (await stat(join(tx15, 'MODELS/model2.yml'))).mtime;
    await applyCopy(tx15, [item!]);
    expect(await readFile(join(tx15, 'MODELS/model2.yml'))).toEqual(m.data);
    expect((await stat(join(tx15, 'MODELS/model2.yml'))).mtime.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await readFile(join(tx15, 'IMAGES/mc.png'), 'utf8')).toBe('mk3 picture');
    expect(await readFile(join(tx15, 'MODELS/Master Copter.txt'), 'utf8')).toBe('check the props');
    expect(await readdir(join(tx15, 'MODELS'))).not.toContain('labels.yml');
  });

  it('adds under the smallest free number when asked, or when no model has the name', async () => {
    const { p, types, b, tx15 } = await setup();
    const origin = await backupOrigin(p, 'tx16smk3', b.name);
    const m = (await readCardState(join(p.backups, 'tx16smk3', b.name))).models[0]!;
    await rm(join(tx15, 'MODELS/model1.yml'));
    const card = await readCardState(tx15);
    const items = await planCopy(card, [{ model: m, origin, mode: 'add' }, { model: { ...m, name: 'Other' }, origin }], types);
    expect(items.map((i) => [i.mode, i.target])).toEqual([
      ['add', 'model1.yml'],
      ['add', 'model3.yml'],
    ]);
  });

  it('with two models of that name on the card, replaces the one with the source file name', async () => {
    const { p, types, b, tx15 } = await setup();
    await writeTree(tx15, { 'MODELS/model1.yml': model('Master Copter') });
    const origin = await backupOrigin(p, 'tx16smk3', b.name);
    const m = (await readCardState(join(p.backups, 'tx16smk3', b.name))).models[0]!;
    const [first] = await planCopy(await readCardState(tx15), [{ model: m, origin }], types);
    expect(first!.target).toBe('model1.yml');
    const [other] = await planCopy(await readCardState(tx15), [{ model: { ...m, file: 'model9.yml' }, origin }], types);
    expect(other!.target).toBe('model1.yml');
    await writeTree(tx15, { 'MODELS/model1.yml': model('Glider') });
    const [onlyTwo] = await planCopy(await readCardState(tx15), [{ model: m, origin }], types);
    expect(onlyTwo!.target).toBe('model2.yml');
  });

  it('notes a newer EdgeTX version and another internal module', async () => {
    const { tx15 } = await setup();
    const m = parseModel('model1.yml', Buffer.from(model('New', { semver: '2.13.0', extra: '' }).replace('TYPE_CROSSFIRE', 'TYPE_MULTIMODULE')));
    const [item] = await planCopy(await readCardState(tx15), [{ model: m, origin: { read: async () => undefined, list: async () => [], isBackup: false } }]);
    expect(item!.newer).toEqual({ model: '2.13.0', radio: '2.12.5' });
    expect(item!.module).toEqual({ model: 'TYPE_MULTIMODULE', radio: 'TYPE_CROSSFIRE' });
  });
});

describe('deleting models', () => {
  it('moves model and checklist to MODELS/DELETED like the radio, and marks the loaded model', async () => {
    const card = await tempDir();
    await writeTree(card, {
      'RADIO/radio.yml': TX15_RADIO,
      'MODELS/model2.yml': model('Copter'),
      'MODELS/model3.yml': model('Copter'),
      'MODELS/Copter.txt': 'shared checklist',
      'MODELS/model2.txt': 'own checklist',
      'MODELS/DELETED/model2.yml': 'older one',
    });
    const items = await planDelete(await readCardState(card), ['model2.yml']);
    expect(items).toEqual([{ name: 'Copter', file: 'model2.yml', moves: ['model2.yml', 'model2.txt'], active: true }]);
    await applyDelete(card, items);
    expect((await readdir(join(card, 'MODELS'))).sort()).toEqual(['Copter.txt', 'DELETED', 'model3.yml']);
    expect(await readFile(join(card, 'MODELS/DELETED/model2.yml'), 'utf8')).toContain('Copter');
    await expect(planDelete(await readCardState(card), ['model9.yml'])).rejects.toMatchObject({ code: 'modelNotFound' });
  });

  it('moves a shared checklist once when both models of a name go, and a model named twice once', async () => {
    const card = await tempDir();
    await writeTree(card, {
      'RADIO/radio.yml': TX15_RADIO,
      'MODELS/model2.yml': model('Copter'),
      'MODELS/model3.yml': model('Copter'),
      'MODELS/Copter.txt': 'shared checklist',
    });
    const items = await planDelete(await readCardState(card), ['model2.yml', 'model3.yml', 'model2.yml']);
    expect(items.map((i) => i.moves)).toEqual([['model2.yml', 'Copter.txt'], ['model3.yml']]);
    expect(await applyDelete(card, items)).toEqual({ written: 0, moved: 3 });
    expect((await readdir(join(card, 'MODELS/DELETED'))).sort()).toEqual(['Copter.txt', 'model2.yml', 'model3.yml']);
  });

  it('leaves no DELETED folder when nothing is deleted', async () => {
    const card = await tempDir();
    await writeTree(card, { 'MODELS/model1.yml': model('A') });
    await applyDelete(card, []);
    expect(await readdir(join(card, 'MODELS'))).toEqual(['model1.yml']);
  });
});

describe('export and import', () => {
  it('names the export after the model', () => {
    expect(exportName(parseModel('model2.yml', Buffer.from(model('A/B: x?'))))).toBe('A_B_ x_.yml');
    expect(parseModel('model3.yml', Buffer.from(model('Quad\\e]0;owned\\a\\u202e'))).name).toBe('Quad]0;owned');
    expect(exportName(parseModel('model2.yml', Buffer.from(model(''))))).toBe('model2.yml');
  });

  it('reads a single model and the models of an .etx file', async () => {
    const one = await readImport('Copter.yml', Buffer.from(model('Copter')));
    expect(one.models.map((m) => m.name)).toEqual(['Copter']);
    expect(one.board).toBeUndefined();
    const etx = await readImport(
      'radio.etx',
      makeZip({ 'RADIO/radio.yml': MK3_RADIO, 'MODELS/model1.yml': model('A'), 'MODELS/model2.yml': model('B'), 'MODELS/labels.yml': 'x' }),
    );
    expect(etx.board).toBe('tx16smk3');
    expect(etx.models.map((m) => [m.file, m.name])).toEqual([
      ['model1.yml', 'A'],
      ['model2.yml', 'B'],
    ]);
    await expect(readImport('x.yml', Buffer.from('just: text'))).rejects.toMatchObject({ code: 'notModelFile' });
    await expect(readImport('x.etx', makeZip({ 'a.txt': 'x' }))).rejects.toMatchObject({ code: 'notModelFile' });
    // a zip that unpacks to more than allowed is refused before it is read
    await expect(readZipBuffer(makeZip({ 'a.txt': '12345', 'b.txt': '678' }), 6)).rejects.toMatchObject({ code: 'invalidRequest' });
    expect([...(await readZipBuffer(makeZip({ 'a.txt': '12345' }), 6)).keys()]).toEqual(['a.txt']);
  });
});

describe('differences', () => {
  it('groups by area, mixes per channel, numbered entries like the radio', () => {
    const a = parseModel('m.yml', Buffer.from(model('A', { weight: 100, extra: 'customFn: \n   0:\n      func: PLAY_TRACK\n      def: "a"\n' }))).doc;
    const b = parseModel('m.yml', Buffer.from(model('B', { weight: 80, extra: 'customFn: \n   0:\n      func: PLAY_TRACK\n      def: "b"\n   1:\n      func: HAPTIC\n' }))).doc;
    expect(diffModels(a, b)).toEqual([
      { area: 'setup', entries: [{ path: 'header › name', from: 'A', to: 'B' }] },
      { area: 'mixes', entries: [{ path: 'Mix CH1, line 1 › weight', from: '100', to: '80' }] },
      {
        area: 'specialFunctions',
        entries: [
          { path: 'SF1 › def', from: 'a', to: 'b' },
          { path: 'SF2', to: 'HAPTIC' },
        ],
      },
    ]);
    expect(diffModels(a, a)).toEqual([]);
  });
});
