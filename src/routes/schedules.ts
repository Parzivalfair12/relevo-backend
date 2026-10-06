import express, { Router, type Request } from 'express';
import mongoose from 'mongoose';
import type { z } from 'zod';
import { daysIn, type Cell, type Code } from '../engine/index.js';
import {
  absenceDeleteSchema, absenceInputSchema, cellsUpdateSchema, defaultCoverage, defaultRules, exportQuerySchema, generateSchema, importBatchSchema, importPreviewQuerySchema, importSchema,
  MESES, newScheduleSchema, scheduleListQuerySchema, scheduleUpdateSchema, type Coverage, type ImportBatchItemDTO, type ImportBatchResultDTO, type ImportPreviewDTO, type ImportResultDTO
} from '../shared/index.js';
import { config } from '../config.js';
import { Schedule, Service, Therapist } from '../models/index.js';
import { HttpError, authenticate } from '../middleware/index.js';
import { h, idParam, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { heavy, regen } from '../lib/limits.js';
import { toOds, toXlsx } from '../lib/export-files.js';
import { ImportError, MAX_FILE_BYTES, matchName, normalizeCells, parseWorkbook } from '../lib/import-sheet.js';
import { buildLayout } from '../lib/sheet-layout.js';
import {
  analyze, assertAccess, commit, isOff, namesFor, neighborsOf, normalize, regenerate, serviceNameMap, statsFrom, summaries, toDTO, versionConflict,
  monthBefore, type MemberDoc, type ScheduleDoc
} from '../lib/schedules.js';

export const schedules = Router();
schedules.use(authenticate);

/** Carga el cuadro, comprueba el alcance de la usuaria y que la versión del cliente sea la vigente. */
async function loadFor(req: Request, version?: number): Promise<ScheduleDoc> {
  const s = (await Schedule.findById(idParam(req)).lean()) as unknown as ScheduleDoc | null;
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Cuadro no encontrado');
  assertAccess(req.user!, s.serviceId);
  if (version !== undefined && s.__v !== version) throw await versionConflict(s._id);
  return normalize(s);
}
const cloneMembers = (s: ScheduleDoc): MemberDoc[] => s.members.map(m => ({ ...m, days: [...m.days], locked: m.locked.map(l => ({ ...l })) }));
const memberOf = (members: MemberDoc[], therapistId: string) => {
  const m = members.find(x => String(x.therapistId) === therapistId);
  if (!m) throw new HttpError(400, 'VALIDATION', 'Esa terapeuta no está en este cuadro.');
  return m;
};
const setLock = (m: MemberDoc, day: number, code: Code | null): boolean => {
  const before = m.locked.length;
  m.locked = m.locked.filter(l => l.day !== day);
  if (code) m.locked.push({ day, code });
  m.locked.sort((a, b) => a.day - b.day);
  return !code && m.locked.length < before; // true si se soltó una casilla fijada
};

/** Tarjetas: el administrador ve todos los cuadros; la coordinadora, los de sus servicios. */
schedules.get('/', h(async (req, res) => {
  const q = parse(scheduleListQuerySchema, req.query);
  if (q.service) assertAccess(req.user!, q.service);
  const all = (await Schedule.find().lean()) as unknown as ScheduleDoc[];
  const visible = all
    .filter(s => req.user!.role === 'admin' || req.user!.serviceIds.includes(String(s.serviceId)))
    .filter(s => (!q.service || String(s.serviceId) === q.service) && (!q.status || s.status === q.status))
    .sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month) || String(a.serviceId).localeCompare(String(b.serviceId)));
  res.json(await summaries(all, visible));
}));

/**
 * Crear un cuadro: toma el equipo del mes anterior del servicio (solo quienes siguen activas) o, si no hay,
 * las terapeutas activas del servicio; copia la cobertura y continúa la secuencia del mes anterior.
 */
schedules.post('/', h(async (req, res) => {
  const d = parse(newScheduleSchema, req.body);
  assertAccess(req.user!, d.serviceId);
  const service: any = await Service.findById(d.serviceId).lean();
  if (!service) throw new HttpError(400, 'VALIDATION', 'El servicio no existe.');
  const dup = () => new HttpError(409, 'DUPLICATE', 'Ya existe un cuadro de este servicio en ese mes.');
  if (await Schedule.exists({ serviceId: d.serviceId, year: d.year, month: d.month })) throw dup();

  const [py, pm] = monthBefore(d.year, d.month);
  const prev = (await Schedule.findOne({ serviceId: d.serviceId, year: py, month: pm }).lean()) as unknown as ScheduleDoc | null;
  let team: { therapistId: mongoose.Types.ObjectId; kind: 'fija' | 'apoyo' }[];
  if (prev) {
    const active = new Set((await Therapist.find({ _id: mongoose.trusted({ $in: prev.members.map(m => m.therapistId) }), active: true }).select('_id').lean()).map((t: any) => String(t._id)));
    team = prev.members.filter(m => active.has(String(m.therapistId))).map(m => ({ therapistId: m.therapistId, kind: m.kind }));
  } else {
    team = (await Therapist.find({ serviceIds: d.serviceId, active: true }).sort({ _id: 1 }).lean()).map((t: any) => ({ therapistId: t._id, kind: t.defaultKind }));
  }
  if (team.length < 2) throw new HttpError(400, 'NOT_ENOUGH_TEAM', 'Este servicio necesita al menos 2 terapeutas activas. Regístralas en Equipo.');

  const coverage: Coverage = prev?.coverage ?? { ...defaultCoverage(), ...(service.defaultCoverage ?? {}) };
  const draft = {
    _id: new mongoose.Types.ObjectId(), serviceId: new mongoose.Types.ObjectId(d.serviceId), year: d.year, month: d.month, status: 'bor' as const,
    ownerId: new mongoose.Types.ObjectId(req.user!.id), coverage, rules: defaultRules(), seed: 3, __v: 0,
    members: team.map(t => ({ ...t, days: [], locked: [] }))
  } as ScheduleDoc;
  const near = await neighborsOf(draft);
  draft.members = await regenerate(normalize(draft), draft.members, {}, near);
  const [names, serviceNames] = await Promise.all([namesFor(draft.members.map(m => m.therapistId)), serviceNameMap()]);
  try {
    const created = await Schedule.create({
      serviceId: draft.serviceId, year: d.year, month: d.month, status: 'bor', ownerId: draft.ownerId, updatedBy: draft.ownerId,
      coverage, rules: draft.rules, seed: draft.seed, members: draft.members, stats: statsFrom(analyze(draft, names, near, serviceNames))
    });
    await audit(req, 'create', 'schedule', created._id, `Creó el cuadro de ${service.name} ${d.month + 1}/${d.year}${prev ? ' continuando el mes anterior' : ''}`);
    res.status(201).json(await toDTO((await Schedule.findById(created._id).lean()) as unknown as ScheduleDoc));
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw dup(); // otra petición lo creó a la vez
    throw e;
  }
}));

/**
 * Importar cuadros del hospital (.xlsx u .ods) en dos pasos:
 *   1. /import/preview recibe el archivo tal cual y devuelve las tablas que encontró, con cómo leyó cada casilla
 *      y qué terapeuta del directorio le corresponde a cada nombre. No guarda nada.
 *   2. /import recibe lo que la usuaria confirmó y crea el cuadro en borrador, con lo importado fijado a mano.
 */
/** Quita tildes, mayúsculas y signos para comparar el nombre de un servicio con el título de una hoja */
const plain = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

schedules.post('/import/preview', heavy, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), h(async (req, res) => {
  const { serviceId } = parse(importPreviewQuerySchema, req.query);
  if (serviceId) assertAccess(req.user!, serviceId);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'VALIDATION', 'Sube un archivo .xlsx o .ods.');
  let tables;
  try { tables = parseWorkbook(req.body); } catch (e) { if (e instanceof ImportError) throw new HttpError(400, 'IMPORT_UNREADABLE', e.message); throw e; }
  if (!tables.length) throw new HttpError(400, 'IMPORT_EMPTY', 'No encontré ninguna tabla de turnos. Busco una fila «FECHA» seguida de los días 1, 2, 3… y debajo una fila por persona.');
  const active = (await Therapist.find({ active: true }).select('name serviceIds').sort({ name: 1 }).lean()) as unknown as { _id: unknown; name: string; serviceIds: unknown[] }[];
  const all = active.map(t => ({ id: String(t._id), name: t.name }));
  // Solo los servicios a los que la usuaria tiene acceso
  const services = ((await Service.find().select('name').lean()) as unknown as { _id: unknown; name: string }[])
    .filter(sv => req.user!.role === 'admin' || req.user!.serviceIds.includes(String(sv._id)))
    .map(sv => ({ id: String(sv._id), key: plain(sv.name) }));
  const serviceOf = (t: { sheet: string; title: string }): string | null => {
    if (serviceId) return serviceId;
    const hay = plain(`${t.title} ${t.sheet}`);
    const hits = services.filter(sv => sv.key && hay.includes(sv.key));
    return hits.length === 1 ? hits[0].id : null;
  };
  const body: ImportPreviewDTO = {
    tables: tables.map(t => {
      const sid = serviceOf(t);
      // Primero entre las terapeutas del servicio (si se conoce); si no hay coincidencia, en todo el directorio
      const mine = sid ? active.filter(x => x.serviceIds.map(String).includes(sid)).map(x => ({ id: String(x._id), name: x.name })) : [];
      return {
        ...t, serviceId: sid,
        people: t.people.map(p => {
          const n = normalizeCells(p.cells, t.days);
          const own = matchName(p.name, mine), m = own.matchId ? own : matchName(p.name, all);
          return { ...p, codes: n.codes, warnings: n.warnings, matchId: m.matchId, suggestions: m.suggestions };
        })
      };
    })
  };
  res.json(body);
}));

/** Crea un cuadro en borrador con lo que la usuaria confirmó. Lo comparten /import y /import/batch. */
async function createImported(req: Request, d: z.infer<typeof importSchema>): Promise<ImportResultDTO> {
  assertAccess(req.user!, d.serviceId);
  const service: any = await Service.findById(d.serviceId).lean();
  if (!service) throw new HttpError(400, 'VALIDATION', 'El servicio no existe.');
  const dup = () => new HttpError(409, 'DUPLICATE', 'Ya existe un cuadro de este servicio en ese mes.');
  if (await Schedule.exists({ serviceId: d.serviceId, year: d.year, month: d.month })) throw dup();
  const ids = d.members.map(m => m.therapistId);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'VALIDATION', 'Hay terapeutas repetidas: cada persona del directorio solo puede salir una vez.');
  const found = (await Therapist.find({ _id: mongoose.trusted({ $in: ids }), active: true }).select('name defaultKind').lean()) as unknown as { _id: mongoose.Types.ObjectId; name: string; defaultKind: 'fija' | 'apoyo' }[];
  if (found.length !== ids.length) throw new HttpError(400, 'VALIDATION', 'Alguna terapeuta no existe o está inactiva.');

  const n = daysIn(d.year, d.month), warnings: string[] = [];
  const members: MemberDoc[] = d.members.map(m => {
    const t = found.find(x => String(x._id) === m.therapistId)!, row = normalizeCells(m.cells, n);
    row.warnings.forEach(w => warnings.push(`${t.name}: ${w}`));
    return { therapistId: t._id, kind: m.kind ?? t.defaultKind, targetHours: m.targetHours ?? null, days: row.codes as Cell[], locked: Object.entries(row.locked).map(([day, code]) => ({ day: Number(day), code })) };
  });
  const coverage: Coverage = { ...defaultCoverage(), ...(service.defaultCoverage ?? {}) };
  const draft = { _id: new mongoose.Types.ObjectId(), serviceId: new mongoose.Types.ObjectId(d.serviceId), year: d.year, month: d.month, status: 'bor' as const, ownerId: new mongoose.Types.ObjectId(req.user!.id), coverage, rules: defaultRules(), seed: 3, __v: 0, members } as ScheduleDoc;
  const [near, names, serviceNames] = await Promise.all([neighborsOf(draft), namesFor(ids), serviceNameMap()]);
  try {
    const created = await Schedule.create({
      serviceId: draft.serviceId, year: d.year, month: d.month, status: 'bor', ownerId: draft.ownerId, updatedBy: draft.ownerId,
      coverage, rules: draft.rules, seed: draft.seed, members, stats: statsFrom(analyze(normalize(draft), names, near, serviceNames))
    });
    await audit(req, 'import', 'schedule', created._id, `Importó el cuadro de ${service.name} ${d.month + 1}/${d.year} (${members.length} personas${warnings.length ? `, ${warnings.length} casillas sin entender` : ''})`);
    return { schedule: await toDTO((await Schedule.findById(created._id).lean()) as unknown as ScheduleDoc), warnings };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw dup();
    throw e;
  }
}

schedules.post('/import', heavy, h(async (req, res) => {
  res.status(201).json(await createImported(req, parse(importSchema, req.body)));
}));

/** Varias tablas del archivo de una vez. No es todo o nada: cada tabla responde por separado (un duplicado no frena las demás). */
schedules.post('/import/batch', heavy, h(async (req, res) => {
  const { tables } = parse(importBatchSchema, req.body);
  const results: ImportBatchItemDTO[] = [];
  for (const [index, t] of tables.entries()) {
    try { results.push({ index, ...(await createImported(req, t)) }); }
    catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      results.push({ index, warnings: [], error: { code: e.code, message: e.message } });
    }
  }
  const body: ImportBatchResultDTO = { results };
  res.status(201).json(body);
}));

/** Descarga el cuadro en el formato del hospital: xlsx (Excel) u ods (LibreOffice). */
schedules.get('/:id/export', heavy, h(async (req, res) => {
  const { format } = parse(exportQuerySchema, req.query);
  const s = await loadFor(req);
  const [service, names] = await Promise.all([Service.findById(s.serviceId).select('name').lean() as Promise<{ name: string } | null>, namesFor(s.members.map(m => m.therapistId))]);
  const serviceName = service?.name ?? 'Servicio';
  const layout = buildLayout({
    serviceName, year: s.year, month: s.month, city: config.EXPORT_CITY,
    members: s.members.map(m => ({ name: names.get(String(m.therapistId)) ?? 'Terapeuta eliminada', kind: m.kind, days: m.days }))
  });
  const file = format === 'ods' ? await toOds(layout) : await toXlsx(layout);
  const base = `${serviceName} - ${MESES[s.month]} ${s.year}`.replace(/[\\/:*?"<>|]/g, '');
  res.setHeader('Content-Type', format === 'ods' ? 'application/vnd.oasis.opendocument.spreadsheet' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cuadro.${format}"; filename*=UTF-8''${encodeURIComponent(`${base}.${format}`)}`);
  res.setHeader('Cache-Control', 'no-store');
  await audit(req, 'export', 'schedule', s._id, `Exportó ${base}.${format}`);
  res.send(file);
}));

schedules.get('/:id', h(async (req, res) => { res.json(await toDTO(await loadFor(req))); }));

/** Alertas del servidor: las reglas del motor más los cruces con otros cuadros del mismo mes. */
schedules.get('/:id/validation', h(async (req, res) => {
  const s = await loadFor(req);
  const [near, names, serviceNames] = await Promise.all([neighborsOf(s), namesFor(s.members.map(m => m.therapistId)), serviceNameMap()]);
  const { issues, gapDays, errors, warnings } = analyze(s, names, near, serviceNames);
  res.json({ issues, gapDays, errors, warnings });
}));

/**
 * Cambia estado, cobertura, reglas y/o equipo. Cobertura, reglas y equipo recalculan el cuadro
 * (respetando las casillas fijadas); el estado por sí solo no.
 */
schedules.patch('/:id', regen, h(async (req, res) => {
  const body = parse(scheduleUpdateSchema, req.body);
  const s = await loadFor(req, body.version);
  let members = cloneMembers(s);
  let regen = false;

  if (body.team) {
    const ids = body.team.map(t => t.therapistId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'VALIDATION', 'Hay terapeutas repetidas en el equipo.');
    const current = new Set(members.map(m => String(m.therapistId)));
    const fresh = ids.filter(i => !current.has(i));
    if (fresh.length) { // solo se pueden sumar terapeutas activas del directorio
      const ok = await Therapist.countDocuments({ _id: mongoose.trusted({ $in: fresh }), active: true });
      if (ok !== fresh.length) throw new HttpError(400, 'VALIDATION', 'Alguna terapeuta no existe o está inactiva.');
    }
    members = body.team.map(t => {
      const old = members.find(m => String(m.therapistId) === t.therapistId);
      const targetHours = t.targetHours === undefined ? old?.targetHours ?? null : t.targetHours; // sin el campo se conserva la meta
      return old ? { ...old, kind: t.kind, targetHours } : { therapistId: new mongoose.Types.ObjectId(t.therapistId), kind: t.kind, targetHours, days: [], locked: [] };
    });
    regen = true;
  }
  const coverage = body.coverage ?? s.coverage, rules = body.rules ?? s.rules;
  if (body.coverage || body.rules) regen = true;

  const near = await neighborsOf(s);
  if (regen) members = await regenerate(normalize({ ...s, members }), members, { coverage, rules }, near);
  const dto = await commit(s, body.version, req.user!.id, { members, coverage, rules, ...(body.status ? { status: body.status } : {}) }, near);

  const what = [
    body.status && (body.status === 'pub' ? 'publicó' : 'volvió a borrador'), body.team && 'cambió el equipo', body.coverage && 'cambió la cobertura', body.rules && 'cambió las reglas'
  ].filter(Boolean).join(', ');
  await audit(req, 'update', 'schedule', s._id, `Cuadro ${s.month + 1}/${s.year}: ${what || 'sin cambios'}`);
  res.json(dto);
}));

/** Pintar o soltar casillas. Pintar fija la casilla; soltar una fijada recalcula el cuadro. */
schedules.put('/:id/cells', h(async (req, res) => {
  const body = parse(cellsUpdateSchema, req.body);
  const s = await loadFor(req, body.version);
  const n = daysIn(s.year, s.month), members = cloneMembers(s);
  let released = false;
  for (const ch of body.changes) {
    if (ch.day >= n) throw new HttpError(400, 'VALIDATION', `El día ${ch.day + 1} no existe en ese mes.`);
    const m = memberOf(members, ch.therapistId);
    if (setLock(m, ch.day, ch.code)) released = true;
    if (ch.code) m.days[ch.day] = ch.code;
  }
  const near = await neighborsOf(s);
  const final = released ? await regenerate(s, members, {}, near) : members;
  res.json(await commit(s, body.version, req.user!.id, { members: final }, near));
}));

/** Generar de nuevo (misma variante) u «Otra variante» (semilla nueva). Respeta lo fijado. */
schedules.post('/:id/generate', regen, h(async (req, res) => {
  const body = parse(generateSchema, req.body);
  const s = await loadFor(req, body.version);
  const seed = body.variant ? (s.seed * 7 + 11) % 9973 + 1 : s.seed;
  const near = await neighborsOf(s);
  const members = await regenerate(s, cloneMembers(s), { seed }, near);
  const dto = await commit(s, body.version, req.user!.id, { members, seed }, near);
  await audit(req, 'update', 'schedule', s._id, `Cuadro ${s.month + 1}/${s.year}: ${body.variant ? 'nueva variante' : 'generó de nuevo'}`);
  res.json(dto);
}));

/** Ausencias por rango (días 1 a n): quedan fijadas como V, I o P y el cuadro se recalcula. */
schedules.post('/:id/absences', regen, h(async (req, res) => {
  const body = parse(absenceInputSchema, req.body);
  const s = await loadFor(req, body.version);
  const n = daysIn(s.year, s.month);
  if (body.to > n) throw new HttpError(400, 'VALIDATION', `Ese mes tiene ${n} días.`);
  const members = cloneMembers(s), m = memberOf(members, body.therapistId);
  for (let d = body.from - 1; d < body.to; d++) setLock(m, d, body.code);
  const near = await neighborsOf(s);
  const dto = await commit(s, body.version, req.user!.id, { members: await regenerate(s, members, {}, near) }, near);
  await audit(req, 'update', 'schedule', s._id, `Cuadro ${s.month + 1}/${s.year}: ausencia ${body.code} del ${body.from} al ${body.to}`);
  res.json(dto);
}));

schedules.delete('/:id/absences', regen, h(async (req, res) => {
  const q = parse(absenceDeleteSchema, req.query);
  const s = await loadFor(req, q.version);
  const members = cloneMembers(s), m = memberOf(members, q.therapistId);
  for (let d = q.from - 1; d < q.to; d++) if (isOff(m.locked.find(l => l.day === d)?.code)) setLock(m, d, null);
  const near = await neighborsOf(s);
  const dto = await commit(s, q.version, req.user!.id, { members: await regenerate(s, members, {}, near) }, near);
  await audit(req, 'update', 'schedule', s._id, `Cuadro ${s.month + 1}/${s.year}: quitó ausencia del ${q.from} al ${q.to}`);
  res.json(dto);
}));
