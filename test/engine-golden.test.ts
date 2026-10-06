// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate, stats, targets, validate, type Config, type Grid } from '../src/engine/index';

/**
 * Casos fijos del motor (engine-golden.json). Este archivo es idéntico en backend y frontend:
 * si el motor se comporta distinto en alguno de los dos, esta prueba falla.
 */
interface GoldenCase { name: string; cfg: Config; grid?: Grid; expected: { grid?: Grid; issues: unknown; targets: unknown; stats: unknown } }
const golden = JSON.parse(readFileSync(new URL('../engine-golden.json', import.meta.url), 'utf8')) as { cases: GoldenCase[] };
// Los resultados se pasan por JSON (como el archivo): quita undefined y deja las claves en texto
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

describe('motor de turnos · casos fijos', () => {
  it('hay casos cargados', () => expect(golden.cases.length).toBeGreaterThanOrEqual(8));

  for (const c of golden.cases) {
    it(c.name, () => {
      const grid = c.grid ?? generate(c.cfg);
      if (c.expected.grid) expect(plain(grid)).toEqual(c.expected.grid);
      expect(plain(validate(c.cfg, grid))).toEqual(c.expected.issues);
      expect(plain(targets(c.cfg, grid))).toEqual(c.expected.targets);
      expect(plain(stats(c.cfg, grid))).toEqual(c.expected.stats);
    });
  }
});
