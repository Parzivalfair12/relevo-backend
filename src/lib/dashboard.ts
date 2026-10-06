import { HRS, daysIn, isWeekend, validate } from '../engine/index.js';
import type { DashboardDTO, DashboardInsight, DashboardTherapistDetail, DashboardTherapistRow, Kind, PatternCell } from '../shared/index.js';
import { busyFor, conflictIssues, gridOf, hoursOfRow, isOff, isWork, normalize, prevFor, toConfig, type ScheduleDoc } from './schedules.js';

/**
 * Agregación del resumen. Mismas reglas que el mockup:
 * cada terapeuta se junta a través de todos los cuadros del período (aunque trabaje en dos servicios);
 * si dos cuadros se pisan un día, gana el turno de trabajo sobre el libre o la ausencia.
 */
interface Agg { id: string; svcs: Set<string>; kinds: Set<Kind>; seq: Map<number, PatternCell[]> }

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const key = (s: { year: number; month: number }) => s.year * 12 + s.month;
export const ymKey = (ym: string) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
export const keyYm = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
const hoursOf = (days: string[]) => sum(days.map(c => HRS[c] || 0));

function finalize(a: Agg, name: string): { row: DashboardTherapistRow; months: DashboardTherapistDetail['months'] } {
  const keys = [...a.seq.keys()].sort((x, y) => x - y);
  const flat = keys.flatMap(k => a.seq.get(k)!);
  const assigned = flat.filter(x => x !== 'x');
  let weekend = 0;
  for (const k of keys) a.seq.get(k)!.forEach((x, d) => { if (isWork(x) && isWeekend(Math.floor(k / 12), k % 12, d + 1)) weekend++; });
  const work = flat.filter(isWork).length;
  // Descanso medio: días libres entre dos bloques de trabajo (no cuenta antes del primero ni después del último)
  const gaps: number[] = []; let cur = 0, started = false;
  for (const x of assigned) { if (isWork(x)) { if (started && cur) gaps.push(cur); started = true; cur = 0; } else cur++; }
  let maxRun = 0, run = 0;
  for (const x of assigned) { run = isWork(x) ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  const row: DashboardTherapistRow = {
    id: a.id, name, serviceIds: [...a.svcs], kinds: [...a.kinds], hours: hoursOf(flat),
    M: flat.filter(x => x === 'M' || x === 'MT').length, T: flat.filter(x => x === 'T' || x === 'MT').length, N: flat.filter(x => x === 'N').length,
    weekendDays: weekend, workDays: work, days: assigned.length, absDays: assigned.filter(isOff).length,
    everyDays: work ? assigned.length / work : 0, restAvg: gaps.length ? sum(gaps) / gaps.length : 0, maxRun, pattern: flat
  };
  return { row, months: keys.map(k => ({ year: Math.floor(k / 12), month: k % 12, hours: hoursOf(a.seq.get(k)!), days: a.seq.get(k)! })) };
}

export interface Aggregated {
  scheduleCount: number; totalDays: number; gapDays: number; conflicts: number; supportHours: number; drafts: number;
  rows: { row: DashboardTherapistRow; months: DashboardTherapistDetail['months'] }[];
}

/** `inRange`: cuadros del período; `all`: todos (para continuidad y cruces). */
export function aggregate(inRange: ScheduleDoc[], all: ScheduleDoc[], names: Map<string, string>, serviceNames: Map<string, string>): Aggregated {
  const A = new Map<string, Agg>();
  let supportHours = 0, totalDays = 0, gapDays = 0, conflicts = 0;
  for (const s of inRange) {
    normalize(s);
    const n = daysIn(s.year, s.month), k = key(s);
    totalDays += n;
    gapDays += new Set(validate(toConfig(s, names, prevFor(s, all)), gridOf(s)).filter(i => i.id === null && i.sev === 'err').map(i => i.day)).size;
    conflicts += conflictIssues(s, names, busyFor(s, all, serviceNames)).length;
    for (const m of s.members) {
      const id = String(m.therapistId);
      const a = A.get(id) ?? { id, svcs: new Set<string>(), kinds: new Set<Kind>(), seq: new Map<number, PatternCell[]>() };
      A.set(id, a);
      a.svcs.add(String(s.serviceId)); a.kinds.add(m.kind);
      const arr = a.seq.get(k) ?? Array<PatternCell>(n).fill('x');
      a.seq.set(k, arr);
      m.days.forEach((code, d) => { if (code && (isWork(code) || arr[d] === 'x' || (arr[d] === 'L' && isOff(code)))) arr[d] = code; });
      if (m.kind === 'apoyo') supportHours += hoursOfRow(m.days);
    }
  }
  return {
    scheduleCount: inRange.length, totalDays, gapDays, conflicts, supportHours, drafts: inRange.filter(s => s.status === 'bor').length,
    rows: [...A.values()].map(a => finalize(a, names.get(a.id) ?? 'Terapeuta eliminada'))
  };
}

const first = (name: string) => name.split(' ')[0];

/** Tarjetas «de atención». Mismos textos que el mockup. */
export function insightsOf(g: Aggregated, serviceList: { id: string; name: string }[]): DashboardInsight[] {
  const out: DashboardInsight[] = [];
  if (g.drafts) out.push({ tone: 'w', icon: '!', title: `${g.drafts} cuadro(s) en borrador.`, text: 'Falta publicarlos para que el equipo los vea.' });
  if (g.conflicts) out.push({ tone: 'w', icon: '!', title: `${g.conflicts} cruce(s) entre servicios.`, text: 'Hay terapeutas en dos cuadros el mismo día.' });
  const fj = g.rows.map(r => r.row).filter(r => r.kinds.includes('fija') && r.hours > 0);
  if (fj.length > 1) {
    // Horas parejas: se compara dentro de cada servicio, descontando los días de ausencia
    const adj = (r: DashboardTherapistRow) => r.hours * r.days / Math.max(r.days - r.absDays, 1);
    let worst: { name: string; hi: DashboardTherapistRow; lo: DashboardTherapistRow; sp: number; rel: number } | null = null;
    for (const sv of serviceList) {
      const grp = fj.filter(r => r.serviceIds.includes(sv.id));
      if (grp.length < 2) continue;
      const hi = grp.reduce((p, q) => (adj(q) > adj(p) ? q : p)), lo = grp.reduce((p, q) => (adj(q) < adj(p) ? q : p));
      const sp = adj(hi) - adj(lo), avg = sum(grp.map(adj)) / grp.length, rel = sp / avg;
      if (!worst || rel > worst.rel) worst = { name: sv.name, hi, lo, sp, rel };
    }
    if (worst) {
      out.push(worst.rel > 0.12
        ? { tone: 'w', icon: '!', title: `Horas desiguales en ${worst.name}.`, text: `${first(worst.hi.name)} ${worst.hi.hours} h frente a ${first(worst.lo.name)} ${worst.lo.hours} h, ya descontando ausencias.` }
        : { tone: 'o', icon: '✓', title: 'Horas parejas en planta.', text: `La diferencia máxima, descontando ausencias, es de ${Math.round(worst.sp)} h dentro de cada servicio.` });
    }
    const most = fj.reduce((a, b) => (b.N > a.N ? b : a));
    out.push({ tone: 'i', icon: 'i', title: 'Más noches:', text: `${most.name} con ${most.N} noche(s). El promedio de planta es ${(sum(fj.map(r => r.N)) / fj.length).toFixed(1)}.` });
  }
  const idle = g.rows.map(r => r.row).filter(r => r.hours === 0).map(r => first(r.name));
  if (idle.length) out.push({ tone: 'i', icon: 'i', title: 'Sin turnos:', text: `${idle.join(', ')}.` });
  return out;
}

/** Horas por mes (apiladas M · T · N): los tres meses más recientes con cuadros. */
export function hoursByMonth(schedules: ScheduleDoc[]): DashboardDTO['hoursByMonth'] {
  const keys = [...new Set(schedules.map(key))].sort((a, b) => b - a).slice(0, 3).sort((a, b) => a - b);
  return keys.map(k => {
    let M = 0, T = 0, N = 0;
    for (const s of schedules.filter(x => key(x) === k)) for (const m of s.members) for (const c of m.days) {
      if (c === 'M') M += 6; else if (c === 'T') T += 6; else if (c === 'N') N += 12; else if (c === 'MT') { M += 6; T += 6; }
    }
    return { year: Math.floor(k / 12), month: k % 12, M, T, N, total: M + T + N };
  });
}

export const totalHours = (s: ScheduleDoc) => sum(s.members.map(m => hoursOfRow(m.days)));
export const rowsToDto = (g: Aggregated) => g.rows.map(r => r.row);
export { key as scheduleKey };
