import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// HeroUI draws form controls in the "secondary" variant on a surface (a card, an alert, a field with a surface
// colour); in the default one their empty box or circle has the surface's own colour in dark mode and can't be
// seen. Read from the source, so it needs no browser; what a helper component puts into a card elsewhere it
// can't see. The secondary variant on the page itself is fine, so only the other way round counts.
// A control marked with data-on-map floats over a map that lies on a surface; it keeps the default variant.

const UI = join(import.meta.dirname, '../src/ui');
const CONTROLS = new Set(['Checkbox', 'RadioGroup', 'Input', 'Select', 'TextArea']);
const SURFACE_TAGS = /^(Card|Alert)(\.|$)/;
const SURFACE_CLASS = /(^|\s)bg-surface(-[a-z]+)?(\s|$)/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
  );
}

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;
const opening = (n: Jsx) => (ts.isJsxElement(n) ? n.openingElement : n);
const tag = (n: Jsx) => opening(n).tagName.getText();
function attr(n: Jsx, name: string): string | undefined {
  for (const a of opening(n).attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name || !a.initializer) continue;
    // the literal parts of a string or a template, enough to find a class or a variant
    return a.initializer.getText().replace(/^[{`'"]+|[}`'"]+$/g, '');
  }
  return undefined;
}
const hasAttr = (n: Jsx, name: string) =>
  opening(n).attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
const isSurface = (n: Jsx) => SURFACE_TAGS.test(tag(n)) || SURFACE_CLASS.test(attr(n, 'className') ?? '');

function hasSurfaceInside(node: ts.Node): boolean {
  let found = false;
  node.forEachChild(function visit(c) {
    if ((ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && isSurface(c)) found = true;
    if (!found) c.forEachChild(visit);
  });
  return found;
}

interface Finding {
  where: string;
  control: string;
  surface: boolean;
  variant?: string;
}

function findings(file: string): Finding[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const walk = (node: ts.Node, ancestors: Jsx[]) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (CONTROLS.has(tag(node)) && !hasAttr(node, 'data-on-map')) {
        const surface = ancestors.some(isSurface) || hasSurfaceInside(node);
        const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push({ where: `${relative(UI, file)}:${line}`, control: tag(node), surface, variant: attr(node, 'variant') });
      }
      ancestors = [...ancestors, node];
    }
    node.forEachChild((c) => walk(c, ancestors));
  };
  walk(src, []);
  return out;
}

describe('form controls', () => {
  const all = files(UI).flatMap(findings);

  it('finds the controls it checks', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('use the secondary variant on a surface', () => {
    const wrong = all.filter((f) => f.surface && f.variant !== 'secondary').map((f) => `${f.where} ${f.control}`);
    expect(wrong).toEqual([]);
  });
});
