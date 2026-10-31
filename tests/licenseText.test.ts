import { describe, expect, it } from 'vitest';
import { isRule, paragraphs, parseLicenses } from '../src/ui/licenseText.ts';

const RULE = '='.repeat(80);
const FILE = [
  'THIRD-PARTY SOFTWARE NOTICES',
  '',
  'App contains the following 2 open source packages.',
  '',
  RULE,
  'a-package 1.0.0',
  'License: MIT',
  'Source: https://example.org/a',
  RULE,
  '',
  'Copyright (c) 2020 Someone',
  'Copyright (c) 2021 Someone Else',
  '',
  'Permission is hereby granted, free of charge,',
  '   to any person obtaining a copy.',
  '',
  RULE,
  'b-package 2.0.0',
  'License: BSD-3-Clause',
  RULE,
  '',
  'Redistribution and use are permitted provided that:',
  '* the notice stays,',
  '* the list stays.',
  '',
  '-----',
  '',
  '   1. Definitions.',
  '',
].join('\n');

describe('license list for reading', () => {
  it('splits the file into packages with license, source and text', () => {
    const l = parseLicenses(FILE);
    expect(l.intro).toEqual(['THIRD-PARTY SOFTWARE NOTICES', 'App contains the following 2 open source packages.']);
    expect(l.packages.map((p) => [p.id, p.license, p.source])).toEqual([
      ['a-package 1.0.0', 'MIT', 'https://example.org/a'],
      ['b-package 2.0.0', 'BSD-3-Clause', undefined],
    ]);
  });

  it('joins the lines of a paragraph, keeps list items, copyright lines and separators apart', () => {
    const [a, b] = parseLicenses(FILE).packages;
    expect(a!.paragraphs).toEqual([
      ['Copyright (c) 2020 Someone', 'Copyright (c) 2021 Someone Else'],
      ['Permission is hereby granted, free of charge, to any person obtaining a copy.'],
    ]);
    expect(b!.paragraphs).toEqual([['Redistribution and use are permitted provided that:', '* the notice stays,', '* the list stays.'], ['-----'], ['1. Definitions.']]);
    expect(isRule(b!.paragraphs[1]!)).toBe(true);
    expect(paragraphs('Copyright (c) 2020, A,\nB and C\nAll rights reserved.')).toEqual([['Copyright (c) 2020, A, B and C', 'All rights reserved.']]);
  });
});
