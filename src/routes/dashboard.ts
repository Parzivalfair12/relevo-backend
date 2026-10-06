import { Router, type Request } from 'express';
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
 */
async function scope(req: Request) {
  const q = parse(dashboardQuerySchema, req.query);
  if (q.service) assertAccess(req.user!, q.service);
  const all = (await Schedule.find().lean()) as unknown as ScheduleDoc[];
  const visible = all.filter(s => req.user!.role === 'admin' || req.user!.serviceIds.includes(String(s.serviceId)));
  const filtered = q.service ? visible.filter(s => String(s.serviceId) === q.service) : visible;
  const latest = filtered.length ? Math.max(...filtered.map(scheduleKey)) : new Date().getFullYear() * 12 + new Date().getMonth();
  const from = q.from ? ymKey(q.from) : q.to ? ymKey(q.to) : latest, to = q.to ? ymKey(q.to) : q.from ? ymKey(q.from) : latest;
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
