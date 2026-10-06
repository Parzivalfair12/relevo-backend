/**
 * Regenera engine-golden.json: casos fijos (entrada + salida esperada) del motor de turnos.
 *
 *   npm run golden:update
 *
 * Úsalo SOLO cuando el comportamiento del motor cambió a propósito. Después: npm run engine:hash, commit,
 * y avisar para que el frontend corra npm run sync:engine. Con el motor sin cambios el archivo queda idéntico.
 * La prueba test/engine-golden.test.ts (idéntica en el frontend) vuelve a ejecutar cada caso y compara con lo guardado.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, stats, targets, validate, daysIn, type Cell, type Code, type Config, type Grid, type Person, type Rules } from '../src/engine/index.js';

const rules: Rules = { seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' };
const cov = { M: 1, T: 1, N: 1 };
const staff = (spec: string): Person[] => spec.split(',').map(s => { const [id, kind] = s.split(':'); return { id, name: id.toUpperCase(), kind: kind === 'apoyo' ? 'apoyo' : 'fija' }; });
const range = (a: number, b: number, code: Code): Record<number, Code> => { const o: Record<number, Code> = {}; for (let d = a; d <= b; d++) o[d] = code; return o; };
const filled = (n: number, code: Cell = 'L'): Cell[] => Array<Cell>(n).fill(code);

interface Case { name: string; cfg: Config; grid?: Grid }

/** Caso de validación: una malla hecha a mano con cada tipo de problema. Septiembre 2026 (30 días). */
function brokenGrid(): Grid {
  const n = daysIn(2026, 8);
  const a = filled(n), b = filled(n), c = filled(n);
  a[0] = 'M';                                   // trabaja el día 1 tras noche del mes anterior (prev de A termina en N)
  a[4] = 'N'; a[5] = 'M';                       // trabaja tras una noche
  b[9] = 'T'; b[10] = 'M';                      // tarde y mañana consecutivas (aviso)
  for (let i = 14; i < 21; i++) b[i] = 'M';     // 7 días seguidos (máx. 5)
  c[19] = 'MT';                                 // doble: cuenta en M y T
  return { a, b, c };
}

const cases: Case[] = [
  { name: 'planta-4-sin-ausencias-sep-2026', cfg: { year: 2026, month: 8, staff: staff('a,b,c,d'), cov, rules, locked: {}, seed: 3 } },
  {
    name: 'uci-4-planta-3-apoyo-con-ausencias-oct-2026',
    cfg: { year: 2026, month: 9, staff: staff('a,b,c,d,e:apoyo,f:apoyo,g:apoyo'), cov, rules, seed: 9,
      locked: { a: range(2, 8, 'V'), b: range(12, 14, 'I'), e: range(0, 9, 'V'), d: { 20: 'P', 21: 'P' } } }
  },
  { name: 'apoyo-por-igual-feb-2026', cfg: { year: 2026, month: 1, staff: staff('a,b,c,d,e:apoyo,f:apoyo'), cov, rules: { ...rules, support: 'equal' }, locked: {}, seed: 5 } },
  {
    name: 'continuidad-mes-anterior-reglas-flojas-nov-2026',
    cfg: { year: 2026, month: 10, staff: staff('a,b,c,d,e:apoyo'), cov, seed: 11, locked: {},
      rules: { seq: false, restAfterN: true, weekends: false, balance: false, maxConsec: 4, support: 'need' },
      prev: { a: ['M', 'T', 'N'], b: ['L', 'M', 'T'], c: ['T', 'N', 'L'], d: ['M', 'M', 'M', 'M'], e: ['V', 'V', 'V'] } }
  },
  { name: 'cobertura-2-1-1-seis-de-planta-ene-2027', cfg: { year: 2027, month: 0, staff: staff('a,b,c,d,e,f'), cov: { M: 2, T: 1, N: 1 }, rules, locked: {}, seed: 2 } },
  {
    name: 'celdas-fijadas-con-doble-y-libre-dic-2026',
    cfg: { year: 2026, month: 11, staff: staff('a,b,c,d,e:apoyo'), cov, rules, seed: 7,
      locked: { a: { 0: 'MT', 1: 'L', 2: 'N' }, b: { 5: 'N', 6: 'L' }, c: range(10, 12, 'I'), e: { 3: 'M' } } }
  },
  {
    name: 'maximo-3-dias-seguidos-mar-2026',
    cfg: { year: 2026, month: 2, staff: staff('a,b,c,d,e:apoyo,f:apoyo'), cov, rules: { ...rules, maxConsec: 3 }, locked: {}, seed: 21 }
  },
  {
    name: 'validar-malla-con-problemas-sep-2026',
    cfg: { year: 2026, month: 8, staff: staff('a,b,c'), cov, rules, locked: {}, prev: { a: ['T', 'N'] } },
    grid: brokenGrid()
  }
];

const out = {
  _nota: 'Generado por npm run golden:update en turnos-backend. No editar a mano.',
  cases: cases.map(({ name, cfg, grid }) => {
    const g = grid ?? generate(cfg);
    const expected = { ...(grid ? {} : { grid: g }), issues: validate(cfg, g), targets: targets(cfg, g), stats: stats(cfg, g) };
    return { name, cfg, ...(grid ? { grid } : {}), expected };
  })
};

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine-golden.json');
// JSON.stringify descarta los undefined y convierte las claves numéricas en texto, igual que al leerlo en la prueba
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`engine-golden.json: ${cases.length} casos`);
