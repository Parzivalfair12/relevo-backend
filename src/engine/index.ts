/**
 * Motor de turnos. TypeScript puro, sin dependencias ni acceso a base de datos.
 * Es un port fiel de referencia/engine-referencia.js: la lógica NO debe cambiar sin actualizar las pruebas.
 *
 * Códigos: M mañana 07-13 (6 h) · T tarde 13-19 (6 h) · N noche 19-07 (12 h) · MT doble (12 h)
 *          L libre · V vacaciones · I incapacidad · P permiso o licencia
 */
export type Code = 'M' | 'T' | 'N' | 'MT' | 'L' | 'V' | 'I' | 'P';
export type Cell = Code | '';
export type Kind = 'fija' | 'apoyo';

export interface Person { id: string; name: string; kind: Kind }
export interface Coverage { M: number; T: number; N: number }
export interface Rules {
  seq: boolean; restAfterN: boolean; weekends: boolean; balance: boolean;
  maxConsec: number; support: 'need' | 'equal';
}
/** locked[personId][dayIndex] = código fijado a mano (índice 0 = día 1) */
export type Locked = Record<string, Record<number, Code>>;
export interface Config {
  year: number; month: number; // month: 0 a 11
  staff: Person[]; cov: Coverage; rules: Rules; locked: Locked; seed?: number;
  /** últimos días del mes anterior por persona, para continuar la secuencia */
  prev?: Record<string, Cell[]>;
}
export type Grid = Record<string, Cell[]>;
export interface Issue { id: string | null; day: number; sev: 'err' | 'warn'; msg: string; sh?: 'M' | 'T' | 'N' }

export const HRS: Record<string, number> = { M: 6, T: 6, N: 12, MT: 12, L: 0, V: 0, I: 0, P: 0 };
const WORK = ['M', 'T', 'N'];
const OFF = ['V', 'I', 'P'];
const NEXT: Record<string, string> = { M: 'T', T: 'N', N: 'L', L: 'M', '': 'M' };

export const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const dow = (y: number, m: number, d: number) => new Date(y, m, d).getDay(); // 0 = domingo
export const isWeekend = (y: number, m: number, d: number) => { const w = dow(y, m, d); return w === 0 || w === 6; };
const isWorkCell = (c: Cell | undefined) => !!c && (WORK.includes(c) || c === 'MT');
const hoursOfRow = (row: Cell[]) => row.reduce((a, c) => a + (HRS[c] || 0), 0);

/** Generador pseudoaleatorio xorshift con semilla: misma semilla, mismo cuadro. */
function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const isSup = (p: Person, rules: Rules) => rules.support === 'need' && p.kind === 'apoyo';

interface PState { last: string; consec: number; h: number; nights: number; wk: number; w: number }

export function generate(cfg: Config): Grid {
  const { year, month, staff, cov, rules, locked, seed } = cfg;
  const n = daysIn(year, month), rand = rng(seed || 1);
  const grid: Grid = {}, st: Record<string, PState> = {};

  staff.forEach(p => {
    grid[p.id] = Array<Cell>(n).fill('');
    let avail = 0;
    for (let i = 0; i < n; i++) { const c = (locked[p.id] || {})[i]; if (!c || !OFF.includes(c)) avail++; }
    const pv = (cfg.prev || {})[p.id] || [];
    const lc = pv.length ? pv[pv.length - 1] : '';
    let cs = 0;
    for (let k = pv.length - 1; k >= 0 && (WORK.includes(pv[k]) || pv[k] === 'MT'); k--) cs++;
    st[p.id] = { last: lc === 'MT' ? 'T' : (OFF.includes(lc) ? 'L' : lc), consec: cs, h: 0, nights: 0, wk: 0, w: Math.max(avail, 1) / n };
  });

  const jit: Record<string, number> = {};
  staff.forEach(p => { jit[p.id] = rand() * 6; });

  for (let d = 0; d < n; d++) {
    const wkend = isWeekend(year, month, d + 1), taken = new Set<string>();
    // 1) celdas fijadas por el usuario
    staff.forEach(p => { const c = (locked[p.id] || {})[d]; if (c) { grid[p.id][d] = c; taken.add(p.id); } });
    const need: Record<string, number> = { N: cov.N, T: cov.T, M: cov.M };
    taken.forEach(id => {
      const c = grid[id][d];
      if (need[c] != null) need[c] = Math.max(0, need[c] - 1);
      if (c === 'MT') { need.M = Math.max(0, need.M - 1); need.T = Math.max(0, need.T - 1); }
    });
    // 2) turnos en orden noche, tarde, mañana
    for (const sh of ['N', 'T', 'M'] as const) {
      for (let k = 0; k < need[sh]; k++) {
        let best: Person | null = null;
        for (const pass of [0, 1]) { // pasada 0: planta; pasada 1: apoyo
          let bs = Infinity;
          for (const p of staff) {
            if (taken.has(p.id)) continue;
            if ((pass === 0) === isSup(p, rules)) continue;
            const s = st[p.id];
            if (rules.restAfterN && s.last === 'N') continue;
            if (rules.seq && s.last === 'T' && sh === 'M') continue;
            if (s.consec >= rules.maxConsec) continue;
            let sc = (s.h / s.w) * 2 + s.consec * 4 + jit[p.id];
            if (rules.seq) {
              if (NEXT[s.last] === sh) sc -= 45;
              else if ((s.last === 'L' || s.last === '') && sh === 'M') sc -= 25;
              else sc += 30;
            }
            if (wkend && rules.weekends) sc += s.wk * 14;
            if (sh === 'N') sc += s.nights * 6;
            if (sc < bs) { bs = sc; best = p; }
          }
          if (best) break;
        }
        if (best) { grid[best.id][d] = sh; taken.add(best.id); }
      }
    }
    // 3) cierre del día: libres y acumulados
    staff.forEach(p => {
      const s = st[p.id]; let c = grid[p.id][d];
      if (!c) { c = 'L'; grid[p.id][d] = 'L'; }
      s.h += HRS[c] || 0;
      if (WORK.includes(c) || c === 'MT') { s.consec++; if (wkend) s.wk++; if (c === 'N') s.nights++; } else s.consec = 0;
      s.last = c === 'MT' ? 'T' : c;
    });
  }
  if (rules.balance) balance(cfg, grid, n, rand);
  return grid;
}

/** Ajuste fino: intercambia turnos entre dos personas el mismo día si reduce la diferencia de horas y no rompe reglas. */
function balance(cfg: Config, grid: Grid, n: number, rand: () => number) {
  const { staff, rules, locked } = cfg;
  const hours = (id: string) => hoursOfRow(grid[id]);
  const tgt = targets(cfg, grid);
  const dev = (id: string) => hours(id) - (tgt[id] as number);
  const lock = (id: string, i: number) => (locked[id] || {})[i];
  const cost = () => {
    let s = 0;
    staff.forEach(p => { if (tgt[p.id] != null) s += Math.abs(dev(p.id)) ** 2; });
    return s + 400 * validate(cfg, grid).filter(v => v.sev === 'err').length;
  };
  let cur = cost();
  for (let it = 0; it < 8000; it++) {
    const a = staff[(rand() * staff.length) | 0], b = staff[(rand() * staff.length) | 0];
    if (a.id === b.id || isSup(a, rules) !== isSup(b, rules)) continue;
    const i = (rand() * n) | 0;
    if (lock(a.id, i) || lock(b.id, i)) continue;
    const ca = grid[a.id][i], cb = grid[b.id][i];
    if (ca === cb) continue;
    grid[a.id][i] = cb; grid[b.id][i] = ca;
    const c2 = cost();
    if (c2 < cur) cur = c2; else { grid[a.id][i] = ca; grid[b.id][i] = cb; }
  }
}

/** Meta de horas por persona de planta (proporcional a sus días disponibles, descontando lo que cubre el apoyo). null = apoyo. */
export function targets(cfg: Pick<Config, 'year' | 'month' | 'staff' | 'cov' | 'rules'>, grid: Grid): Record<string, number | null> {
  const { year, month, staff, cov, rules } = cfg;
  const n = daysIn(year, month);
  const perDay = cov.M * 6 + cov.T * 6 + cov.N * 12;
  let total = perDay * n, wsum = 0;
  const w: Record<string, number> = {}, t: Record<string, number | null> = {};
  staff.forEach(p => {
    if (isSup(p, rules)) { total -= hoursOfRow(grid[p.id]); return; }
    let a = 0; for (let i = 0; i < n; i++) if (!OFF.includes(grid[p.id][i])) a++;
    w[p.id] = a; wsum += a;
  });
  staff.forEach(p => { t[p.id] = isSup(p, rules) ? null : (wsum ? Math.max(total, 0) * w[p.id] / wsum : 0); });
  return t;
}

/** Validación. day = número de día (1 a n). id null = problema de cobertura. */
export function validate(cfg: Config, grid: Grid): Issue[] {
  const { year, month, staff, cov, rules } = cfg, n = daysIn(year, month), out: Issue[] = [];
  staff.forEach(p => {
    const g = grid[p.id]; let run = 0;
    // Continuidad con el mes anterior: si terminó en noche, el día 1 debe ser descanso o ausencia
    const pv = (cfg.prev || {})[p.id] || [], pl = pv.length ? pv[pv.length - 1] : '';
    if (rules.restAfterN && pl === 'N' && g[0] && g[0] !== 'L' && !OFF.includes(g[0]))
      out.push({ id: p.id, day: 1, sev: 'err', msg: `${p.name}: trabaja el 1 después de noche del mes anterior (falta descanso)` });
    for (let i = 0; i < n; i++) {
      const c = g[i], nx = g[i + 1];
      const w = WORK.includes(c) || c === 'MT';
      run = w ? run + 1 : 0;
      if (rules.restAfterN && c === 'N' && nx && nx !== 'L' && !OFF.includes(nx))
        out.push({ id: p.id, day: i + 1, sev: 'err', msg: `${p.name}: trabaja el ${i + 2} después de noche (falta descanso)` });
      if (rules.seq && c === 'T' && nx === 'M')
        out.push({ id: p.id, day: i + 1, sev: 'warn', msg: `${p.name}: tarde y mañana consecutivas (${i + 1}→${i + 2}), solo 12 h de descanso` });
      if (run > rules.maxConsec)
        out.push({ id: p.id, day: i + 1, sev: 'err', msg: `${p.name}: ${run} días seguidos de trabajo (máx. ${rules.maxConsec})` });
    }
  });
  for (let i = 0; i < n; i++) {
    for (const sh of ['M', 'T', 'N'] as const) {
      let c = 0;
      staff.forEach(p => { const x = grid[p.id][i]; if (x === sh || (x === 'MT' && sh !== 'N')) c++; });
      if (c < cov[sh]) out.push({ id: null, day: i + 1, sev: 'err', sh, msg: `Día ${i + 1}: falta cubrir turno ${sh} (${c}/${cov[sh]})` });
      else if (c > cov[sh]) out.push({ id: null, day: i + 1, sev: 'warn', sh, msg: `Día ${i + 1}: sobran terapeutas en turno ${sh} (${c}/${cov[sh]})` });
    }
  }
  return out;
}

export interface PersonStats {
  id: string; hours: number; M: number; T: number; N: number; MT: number;
  workDays: number; restDays: number; absDays: number; weekendDays: number;
  maxConsec: number; avgRest: number; // avgRest = promedio de días libres entre bloques de trabajo
}
/** Estadísticas por persona para el resumen y el panel de equidad. */
export function stats(cfg: Pick<Config, 'year' | 'month' | 'staff'>, grid: Grid): PersonStats[] {
  const n = daysIn(cfg.year, cfg.month);
  return cfg.staff.map(p => {
    const g = grid[p.id] || [];
    const s: PersonStats = { id: p.id, hours: hoursOfRow(g), M: 0, T: 0, N: 0, MT: 0, workDays: 0, restDays: 0, absDays: 0, weekendDays: 0, maxConsec: 0, avgRest: 0 };
    let run = 0, gap = 0, seenWork = false;
    const gaps: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = g[i];
      if (isWorkCell(c)) {
        s.workDays++; run++; s.maxConsec = Math.max(s.maxConsec, run);
        if (c === 'M') s.M++; else if (c === 'T') s.T++; else if (c === 'N') s.N++; else if (c === 'MT') s.MT++;
        if (isWeekend(cfg.year, cfg.month, i + 1)) s.weekendDays++;
        if (seenWork && gap > 0) gaps.push(gap);
        gap = 0; seenWork = true;
      } else {
        run = 0;
        if (c && OFF.includes(c)) s.absDays++; else if (c === 'L') s.restDays++;
        gap++;
      }
    }
    s.avgRest = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    return s;
  });
}
