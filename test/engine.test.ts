import { describe, it, expect } from 'vitest';
import { generate, validate, targets, stats, HRS, daysIn, type Config, type Person, type Locked } from '../src/engine/index';

const rules = { seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' as const };
const cov = { M: 1, T: 1, N: 1 };
const P = (id: string, kind: 'fija' | 'apoyo' = 'fija'): Person => ({ id, name: id.toUpperCase(), kind });
const hours = (g: string[]) => g.reduce((a, c) => a + (HRS[c] || 0), 0);
const range = (a: number, b: number, code: any) => { const o: Record<number, any> = {}; for (let d = a; d <= b; d++) o[d] = code; return o; };

describe('motor de turnos', () => {
  it('4 de planta sin ausencias: 180 h cada una en un mes de 30 días (septiembre 2026)', () => {
    const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd'].map(i => P(i)), cov, rules, locked: {}, seed: 3 };
    expect(daysIn(2026, 8)).toBe(30);
    const g = generate(cfg);
    for (const p of cfg.staff) expect(hours(g[p.id])).toBe(180);
    expect(validate(cfg, g).filter(v => v.sev === 'err')).toEqual([]);
  });

  it('nunca se trabaja el día siguiente a una noche', () => {
    for (const seed of [1, 2, 3, 7, 11, 99]) {
      const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd', 'e'].map(i => P(i)), cov, rules, locked: {}, seed };
      const g = generate(cfg);
      for (const p of cfg.staff) for (let i = 0; i < 29; i++) if (g[p.id][i] === 'N') expect(['L', 'V', 'I', 'P']).toContain(g[p.id][i + 1]);
    }
  });

  it('con 4 de planta + 3 de apoyo y ausencias no queda ningún día sin cubrir', () => {
    const staff = [P('a'), P('b'), P('c'), P('d'), P('e', 'apoyo'), P('f', 'apoyo'), P('g', 'apoyo')];
    const locked: Locked = { b: range(9, 11, 'I'), d: range(17, 18, 'P'), a: range(20, 26, 'V') };
    const cfg: Config = { year: 2026, month: 8, staff, cov, rules, locked, seed: 3 };
    const g = generate(cfg);
    const errs = validate(cfg, g).filter(v => v.sev === 'err');
    expect(errs).toEqual([]);
    for (let i = 0; i < 30; i++) {
      for (const sh of ['M', 'T', 'N']) expect(staff.filter(p => g[p.id][i] === sh).length).toBe(1);
    }
  });

  it('el apoyo solo aparece cuando falta alguien de planta', () => {
    const staff = [P('a'), P('b'), P('c'), P('d'), P('e', 'apoyo')];
    const cfg: Config = { year: 2026, month: 8, staff, cov, rules, locked: {}, seed: 5 };
    const g = generate(cfg);
    expect(hours(g.e)).toBe(0);
  });

  it('7 personas: diferencia de horas entre la planta ≤ 6 h', () => {
    const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(i => P(i)), cov, rules, locked: {}, seed: 3 };
    const g = generate(cfg);
    const hs = cfg.staff.map(p => hours(g[p.id]));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(6);
  });

  it('las casillas fijadas se respetan y misma semilla da el mismo cuadro', () => {
    const locked: Locked = { a: { 0: 'P', 1: 'P' } };
    const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd'].map(i => P(i)), cov, rules, locked, seed: 4 };
    const g1 = generate(cfg), g2 = generate(cfg);
    expect(g1.a[0]).toBe('P'); expect(g1.a[1]).toBe('P');
    expect(g1).toEqual(g2);
  });

  it('continuidad: si terminó el mes anterior en noche, el día 1 es libre', () => {
    const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd'].map(i => P(i)), cov, rules, locked: {}, seed: 3, prev: { a: ['M', 'T', 'N'] } };
    expect(generate(cfg).a[0]).not.toMatch(/^(M|T|N|MT)$/);
  });

  it('validate detecta trabajo tras noche y huecos de cobertura', () => {
    const cfg: Config = { year: 2026, month: 8, staff: [P('a')], cov, rules, locked: {} };
    const grid = { a: Array(30).fill('L') as any[] };
    grid.a[0] = 'N'; grid.a[1] = 'M';
    const out = validate(cfg, grid);
    expect(out.some(v => v.id === 'a' && v.sev === 'err' && v.day === 1)).toBe(true);
    expect(out.some(v => v.id === null && v.sev === 'err')).toBe(true);
  });

  it('validate marca error si el día 1 trabaja tras una noche del mes anterior', () => {
    const cfg: Config = { year: 2026, month: 8, staff: [P('a')], cov: { M: 0, T: 0, N: 0 }, rules, locked: {}, prev: { a: ['T', 'N'] } };
    const grid = { a: Array(30).fill('L') as any[] };
    grid.a[0] = 'M';
    expect(validate(cfg, grid).some(v => v.id === 'a' && v.day === 1 && v.sev === 'err')).toBe(true);
    grid.a[0] = 'L';
    expect(validate(cfg, grid).filter(v => v.sev === 'err')).toEqual([]);
  });

  it('targets y stats son coherentes', () => {
    const cfg: Config = { year: 2026, month: 8, staff: ['a', 'b', 'c', 'd'].map(i => P(i)), cov, rules, locked: {}, seed: 3 };
    const g = generate(cfg);
    const t = targets(cfg, g);
    expect(t.a).toBeCloseTo(180, 5);
    const s = stats(cfg, g);
    expect(s[0].hours).toBe(s[0].M * 6 + s[0].T * 6 + s[0].N * 12 + s[0].MT * 12);
    expect(s[0].workDays + s[0].restDays + s[0].absDays).toBe(30);
  });
});
