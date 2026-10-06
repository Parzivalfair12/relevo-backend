import mongoose from 'mongoose';
import { HRS, daysIn, validate, type Cell, type Code, type Config, type Grid, type Issue, type Person } from '../engine/index.js';
import type { Coverage, Kind, Rules, ScheduleDTO, ScheduleSummaryDTO, VersionConflictDetails } from '../shared/index.js';
import { Schedule, Service, Therapist, User } from '../models/index.js';
import { HttpError, type AuthUser } from '../middleware/index.js';

/* ===== Tipos de trabajo (documentos "lean" de Mongo) ===== */
export interface MemberDoc { therapistId: mongoose.Types.ObjectId; kind: Kind; targetHours?: number | null; days: Cell[]; locked: { day: number; code: Code }[] }
export interface ScheduleDoc {
  _id: mongoose.Types.ObjectId; serviceId: mongoose.Types.ObjectId; year: number; month: number; status: 'bor' | 'pub';
  ownerId: mongoose.Types.ObjectId; updatedBy?: mongoose.Types.ObjectId; coverage: Coverage; rules: Rules; seed: number;
  members: MemberDoc[]; __v: number
}

const WORK: string[] = ['M', 'T', 'N', 'MT'];
const OFF: string[] = ['V', 'I', 'P'];
export const isWork = (c: string | undefined) => !!c && WORK.includes(c);
export const isOff = (c: string | undefined) => !!c && OFF.includes(c);
export const monthBefore = (y: number, m: number): [number, number] => (m === 0 ? [y - 1, 11] : [y, m - 1]);
export const neededHours = (cov: Coverage, n: number) => (cov.M * 6 + cov.T * 6 + cov.N * 12) * n;
export const hoursOfRow = (row: Cell[]) => row.reduce((a, c) => a + (HRS[c] || 0), 0);

/** Un cuadro solo lo ve y edita el administrador o la coordinadora con ese servicio asignado. */
export function assertAccess(user: AuthUser, serviceId: unknown) {
  if (user.role === 'admin' || user.serviceIds.includes(String(serviceId))) return;
  throw new HttpError(403, 'FORBIDDEN', 'No tienes permiso sobre los cuadros de este servicio');
}

/** Normaliza un documento: cada persona con un código por día (si falta algo, 'L'). */
export function normalize(s: ScheduleDoc): ScheduleDoc {
  const n = daysIn(s.year, s.month);
  for (const m of s.members) {
    m.days = Array.from({ length: n }, (_, i) => (m.days?.[i] ?? 'L') as Cell);
    m.locked = (m.locked ?? []).filter(l => l.day >= 0 && l.day < n);
  }
  return s;
}

export const lockedOf = (m: MemberDoc): Record<number, Code> => Object.fromEntries(m.locked.map(l => [l.day, l.code]));
const idOf = (m: MemberDoc) => String(m.therapistId);

/** Casillas del mes anterior del MISMO servicio (las últimas 7 por persona) para continuar la secuencia. */
export function prevFor(s: ScheduleDoc, others: ScheduleDoc[]): Record<string, Cell[]> {
  const [py, pm] = monthBefore(s.year, s.month);
  const prev = others.find(o => String(o.serviceId) === String(s.serviceId) && o.year === py && o.month === pm);
  const out: Record<string, Cell[]> = {};
  if (!prev) return out;
  for (const m of s.members) {
    const pmem = prev.members.find(x => idOf(x) === idOf(m));
    if (pmem?.days?.length) out[idOf(m)] = pmem.days.slice(-7);
  }
  return out;
}

/** Días en que cada terapeuta ya trabaja en OTRO cuadro del mismo mes (terapeuta → día → servicios). */
export function busyFor(s: ScheduleDoc, others: ScheduleDoc[], serviceNames: Map<string, string>): Record<string, Record<number, string>> {
  const busy: Record<string, Record<number, string>> = {};
  const mine = new Map(s.members.map(m => [idOf(m), m]));
  for (const o of others) {
    if (String(o._id) === String(s._id) || o.year !== s.year || o.month !== s.month) continue;
    const label = serviceNames.get(String(o.serviceId)) ?? 'otro servicio';
    for (const om of o.members) {
      const m = mine.get(idOf(om)); if (!m) continue;
      om.days.forEach((c, d) => {
        if (!isWork(c) || !isWork(m.days[d])) return; // solo cuenta si las dos casillas son de trabajo
        const row = (busy[idOf(m)] ??= {});
        row[d] = row[d] && !row[d].split(', ').includes(label) ? `${row[d]}, ${label}` : label;
      });
    }
  }
  return busy;
}

/** El mismo texto que el mockup: «Nombre: el día N también trabaja en Servicio». */
export function conflictIssues(s: ScheduleDoc, names: Map<string, string>, busy: Record<string, Record<number, string>>): Issue[] {
  const out: Issue[] = [];
  for (const m of s.members) {
    const b = busy[idOf(m)]; if (!b) continue;
    m.days.forEach((c, d) => { if (isWork(c) && b[d]) out.push({ id: idOf(m), day: d + 1, sev: 'err', msg: `${names.get(idOf(m)) ?? 'Terapeuta'}: el día ${d + 1} también trabaja en ${b[d]}` }); });
  }
  return out;
}

export function toConfig(s: ScheduleDoc, names: Map<string, string>, prev: Record<string, Cell[]>): Config {
  const staff: Person[] = s.members.map(m => ({ id: idOf(m), name: names.get(idOf(m)) ?? 'Terapeuta eliminada', kind: m.kind, targetHours: m.targetHours ?? null }));
  const locked: Config['locked'] = {};
  for (const m of s.members) locked[idOf(m)] = lockedOf(m);
  return { year: s.year, month: s.month, staff, cov: s.coverage, rules: s.rules, locked, seed: s.seed, prev };
}
export const gridOf = (s: ScheduleDoc): Grid => Object.fromEntries(s.members.map(m => [idOf(m), m.days]));

export async function namesFor(ids: unknown[]): Promise<Map<string, string>> {
  const list = await Therapist.find({ _id: mongoose.trusted({ $in: ids }) }).select('name').lean();
  return new Map(list.map((t: any) => [String(t._id), t.name as string]));
}
export async function serviceNameMap(): Promise<Map<string, string>> {
  return new Map((await Service.find().select('name').lean()).map((x: any) => [String(x._id), x.name as string]));
}

/** Cuadros que importan para uno: el mismo mes (cruces) y el anterior (continuidad). */
export async function neighborsOf(s: ScheduleDoc): Promise<ScheduleDoc[]> {
  const [py, pm] = monthBefore(s.year, s.month);
  return (await Schedule.find({ $or: [{ year: s.year, month: s.month }, { year: py, month: pm }] }).lean()) as unknown as ScheduleDoc[];
}

export interface Analysis { issues: Issue[]; gapDays: number; errors: number; warnings: number; hours: number; needed: number }
export function analyze(s: ScheduleDoc, names: Map<string, string>, others: ScheduleDoc[], serviceNames: Map<string, string>): Analysis & { prev: Record<string, Cell[]>; busy: Record<string, Record<number, string>> } {
  const prev = prevFor(s, others), busy = busyFor(s, others, serviceNames);
  const issues = validate(toConfig(s, names, prev), gridOf(s)).concat(conflictIssues(s, names, busy));
  const n = daysIn(s.year, s.month);
  return {
    issues, prev, busy,
    gapDays: new Set(issues.filter(i => i.id === null && i.sev === 'err').map(i => i.day)).size,
    errors: issues.filter(i => i.sev === 'err').length, warnings: issues.filter(i => i.sev === 'warn').length,
    hours: s.members.reduce((a, m) => a + hoursOfRow(m.days), 0), needed: neededHours(s.coverage, n)
  };
}

/** Datos que se guardan junto al cuadro para leer las tarjetas sin recorrer los turnos. */
export const statsFrom = (a: Analysis) => ({ hours: a.hours, needed: a.needed, gapDays: a.gapDays, errors: a.errors, warnings: a.warnings });

export async function toDTO(s: ScheduleDoc): Promise<ScheduleDTO> {
  normalize(s);
  const [others, serviceNames, names, users] = await Promise.all([
    neighborsOf(s), serviceNameMap(), namesFor(s.members.map(m => m.therapistId)),
    User.find({ _id: mongoose.trusted({ $in: [s.ownerId, s.updatedBy].filter(Boolean) }) }).select('name').lean()
  ]);
  const userName = (id?: unknown) => (users as any[]).find(u => String(u._id) === String(id))?.name as string | undefined;
  const a = analyze(s, names, others, serviceNames);
  return {
    id: String(s._id), serviceId: String(s.serviceId), year: s.year, month: s.month, status: s.status,
    ownerId: String(s.ownerId), ownerName: userName(s.ownerId) ?? 'Usuario', updatedByName: userName(s.updatedBy),
    coverage: s.coverage, rules: s.rules, seed: s.seed, version: s.__v, prev: a.prev, busy: a.busy,
    members: s.members.map(m => ({ therapistId: idOf(m), name: names.get(idOf(m)) ?? 'Terapeuta eliminada', kind: m.kind, targetHours: m.targetHours ?? null, days: m.days, locked: lockedOf(m) }))
  };
}

/** Tarjetas de la lista. Las alertas críticas incluyen los cruces con otros servicios, como en el mockup. */
export async function summaries(all: ScheduleDoc[], visible: ScheduleDoc[]): Promise<ScheduleSummaryDTO[]> {
  const [serviceNames, names, users] = await Promise.all([
    serviceNameMap(), namesFor([...new Set(visible.flatMap(s => s.members.map(m => String(m.therapistId))))]),
    User.find({ _id: mongoose.trusted({ $in: visible.map(s => s.ownerId) }) }).select('name').lean()
  ]);
  return visible.map(s => {
    normalize(s);
    const a = analyze(s, names, all, serviceNames);
    return {
      id: String(s._id), serviceId: String(s.serviceId), year: s.year, month: s.month, status: s.status, ownerId: String(s.ownerId),
      ownerName: ((users as any[]).find(u => String(u._id) === String(s.ownerId))?.name as string) ?? 'Usuario',
      days: daysIn(s.year, s.month), totalHours: a.hours, neededHours: a.needed,
      planta: s.members.filter(m => m.kind === 'fija').length, apoyo: s.members.filter(m => m.kind === 'apoyo').length, criticalAlerts: a.errors
    };
  });
}

/** Vuelve a generar los turnos respetando lo fijado, en el worker. Devuelve los miembros con los días nuevos. */
export async function regenerate(s: ScheduleDoc, members: MemberDoc[], over: { coverage?: Coverage; rules?: Rules; seed?: number }, others: ScheduleDoc[]): Promise<MemberDoc[]> {
  const { generateInWorker } = await import('./generate.js');
  const draft: ScheduleDoc = { ...s, members, coverage: over.coverage ?? s.coverage, rules: over.rules ?? s.rules, seed: over.seed ?? s.seed };
  const grid = await generateInWorker(toConfig(draft, new Map(), prevFor(draft, others)));
  return members.map(m => ({ ...m, days: grid[idOf(m)] }));
}

/**
 * Escritura con control de versiones: solo se guarda si el cuadro sigue en la versión que el cliente conocía.
 * Si no, 409 con quién hizo el último cambio.
 */
export async function saveVersioned(s: ScheduleDoc, version: number, set: Record<string, unknown>, userId: string, analysis: Analysis) {
  const r = await Schedule.updateOne(
    { _id: s._id, __v: version },
    { $set: { ...set, updatedBy: userId, stats: statsFrom(analysis) }, $inc: { __v: 1 } }
  );
  if (r.matchedCount !== 1) throw await versionConflict(s._id);
}

export async function versionConflict(id: unknown): Promise<HttpError> {
  const cur: any = await Schedule.findById(id).select('__v updatedBy').lean();
  if (!cur) return new HttpError(404, 'NOT_FOUND', 'Cuadro no encontrado');
  const by: any = cur.updatedBy ? await User.findById(cur.updatedBy).select('name').lean() : null;
  const details: VersionConflictDetails = { updatedByName: by?.name, version: cur.__v };
  return new HttpError(409, 'VERSION_CONFLICT', `${by?.name ?? 'Otra persona'} cambió este cuadro mientras lo editabas.`, details);
}


/**
 * Cierra una operación de escritura: valida el resultado, lo guarda con control de versiones
 * y devuelve el cuadro tal como quedó (con la versión nueva).
 */
export async function commit(s: ScheduleDoc, version: number, userId: string, set: Partial<Pick<ScheduleDoc, 'members' | 'coverage' | 'rules' | 'seed' | 'status'>>, others?: ScheduleDoc[]): Promise<ScheduleDTO> {
  const draft = normalize({ ...s, ...set } as ScheduleDoc);
  const [near, names, serviceNames] = await Promise.all([others ?? neighborsOf(s), namesFor(draft.members.map(m => m.therapistId)), serviceNameMap()]);
  await saveVersioned(s, version, set as Record<string, unknown>, userId, analyze(draft, names, near, serviceNames));
  return toDTO((await Schedule.findById(s._id).lean()) as unknown as ScheduleDoc);
}
