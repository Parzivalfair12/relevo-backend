import { Router, type Request } from 'express';
import mongoose from 'mongoose';
import { dashboardQuerySchema, type DashboardDTO, type DashboardTherapistDetail } from '../shared/index.js';
import { Schedule, Service } from '../models/index.js';
import { HttpError, authenticate } from '../middleware/index.js';
import { h, idParam, parse } from '../lib/http.js';
import { assertAccess, namesFor, serviceNameMap, type ScheduleDoc } from '../lib/schedules.js';
import { aggregate, hoursByMonth, insightsOf, keyYm, scheduleKey, totalHours, ymKey } from '../lib/dashboard.js';

export const dashboard = Router();
dashboard.use(authenticate);

/**
 * Carga lo que el resumen necesita según quién pregunta:
 * administrador = todos los cuadros; coordinadora = solo los de sus servicios (403 si pide otro servicio).
 * Sin período, se toma el mes más reciente que tenga cuadros.
 *
 * No se lee todo el histórico: primero se averiguan, con una agregación liviana, los tres meses más recientes (para el gráfico
 * de horas por mes) y de ahí el período; después solo se cargan los cuadros de esos meses y del mes anterior al período
 * (continuidad y cruces), de todos los servicios.
 */
async function scope(req: Request) {
  const q = parse(dashboardQuerySchema, req.query);
  if (q.service) assertAccess(req.user!, q.service);
  const admin = req.user!.role === 'admin';
  // La agregación no pasa por la conversión de tipos de Mongoose: los ids se convierten aquí
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const match: Record<string, unknown> = q.service ? { serviceId: oid(q.service) } : admin ? {} : { serviceId: { $in: req.user!.serviceIds.map(oid) } };
  const recent = (await Schedule.aggregate([
    { $match: match }, { $group: { _id: { y: '$year', m: '$month' } } }, { $sort: { '_id.y': -1, '_id.m': -1 } }, { $limit: 3 }
  ])).map(r => r._id.y * 12 + r._id.m as number);

  const latest = recent.length ? recent[0] : new Date().getFullYear() * 12 + new Date().getMonth();
  const from = q.from ? ymKey(q.from) : q.to ? ymKey(q.to) : latest, to = q.to ? ymKey(q.to) : q.from ? ymKey(q.from) : latest;
  const needed = (k: number) => (k >= from - 1 && k <= to) || recent.includes(k);
  const keys = [from - 1, to, ...recent];
  const all = ((await Schedule.find({ year: mongoose.trusted({ $gte: Math.floor(Math.min(...keys) / 12), $lte: Math.floor(Math.max(...keys) / 12) }) }).lean()) as unknown as ScheduleDoc[])
    .filter(s => needed(scheduleKey(s)));
  const visible = all.filter(s => admin || req.user!.serviceIds.includes(String(s.serviceId)));
  const filtered = q.service ? visible.filter(s => String(s.serviceId) === q.service) : visible;
  const inRange = filtered.filter(s => scheduleKey(s) >= from && scheduleKey(s) <= to);
  const [names, serviceNames, services] = await Promise.all([
    namesFor([...new Set(inRange.flatMap(s => s.members.map(m => String(m.therapistId))))]), serviceNameMap(), Service.find().sort({ _id: 1 }).lean()
  ]);
  return { q, all, visible, filtered, inRange, from, to, names, serviceNames, services: services as unknown as { _id: unknown; name: string }[] };
}

/** Resumen: indicadores, tarjetas de atención, carga por terapeuta y gráficos de horas. */
dashboard.get('/', h(async (req, res) => {
  const c = await scope(req);
  const g = aggregate(c.inRange, c.all, c.names, c.serviceNames);
  const rows = g.rows.map(r => r.row);
  const hours = rows.reduce((a, r) => a + r.hours, 0), active = rows.filter(r => r.hours > 0).length;
  const mine = c.services.filter(sv => req.user!.role === 'admin' || req.user!.serviceIds.includes(String(sv._id)));
  const body: DashboardDTO = {
    from: keyYm(c.from), to: keyYm(c.to), scheduleCount: g.scheduleCount,
    kpis: {
      hours, activeTherapists: active, idleTherapists: rows.length - active,
      coveragePct: g.totalDays ? Math.round((g.totalDays - g.gapDays) / g.totalDays * 100) : 100, gapDays: g.gapDays, totalDays: g.totalDays,
      supportHours: g.supportHours, supportPct: hours ? Math.round(g.supportHours / hours * 100) : 0, absenceDays: rows.reduce((a, r) => a + r.absDays, 0)
    },
    insights: insightsOf(g, mine.map(sv => ({ id: String(sv._id), name: sv.name }))),
    therapists: rows,
    hoursByMonth: hoursByMonth(c.filtered),
    hoursByService: mine.map(sv => ({ serviceId: String(sv._id), hours: c.visible.filter(s => String(s.serviceId) === String(sv._id) && scheduleKey(s) >= c.from && scheduleKey(s) <= c.to).reduce((a, s) => a + totalHours(s), 0) }))
  };
  res.json(body);
}));

/** Detalle de una terapeuta en el período: sus cifras y su patrón mes a mes. */
dashboard.get('/therapists/:id', h(async (req, res) => {
  const id = idParam(req), c = await scope(req);
  const found = aggregate(c.inRange, c.all, c.names, c.serviceNames).rows.find(r => r.row.id === id);
  if (!found) throw new HttpError(404, 'NOT_FOUND', 'Esa terapeuta no tiene turnos en el período.');
  const body: DashboardTherapistDetail = { ...found.row, months: found.months };
  res.json(body);
}));
