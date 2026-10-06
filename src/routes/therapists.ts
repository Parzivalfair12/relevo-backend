import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { kindSchema, therapistInputSchema } from '../shared/index.js';
import { Schedule, Therapist } from '../models/index.js';
import { HttpError, authenticate, requireRole } from '../middleware/index.js';
import { checkServices, ci, h, idParam, notId, parse } from '../lib/http.js';
import { therapistDTO } from '../lib/dto.js';
import { audit } from '../lib/audit.js';

export const therapists = Router();
therapists.use(authenticate);

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  service: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  kind: kindSchema.optional(),
  active: z.enum(['true', 'false']).optional()
});
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cuántos cuadros incluyen a cada terapeuta (el directorio lo muestra en la columna "Cuadros"). */
async function scheduleCounts(ids?: unknown[]): Promise<Map<string, number>> {
  // aggregate no pasa por sanitizeFilter, por eso aquí $in va sin marcar
  const rows = await Schedule.aggregate([
    { $unwind: '$members' },
    ...(ids ? [{ $match: { 'members.therapistId': { $in: ids } } }] : []),
    { $group: { _id: '$members.therapistId', n: { $sum: 1 } } }
  ]);
  return new Map(rows.map(r => [String(r._id), r.n as number]));
}

/** Lectura para todos (administradoras y coordinadoras); escritura solo administradores. */
therapists.get('/', h(async (req, res) => {
  const { q, service, kind, active } = parse(querySchema, req.query);
  const filter: Record<string, unknown> = {};
  if (service) filter.serviceIds = service;
  if (kind) filter.defaultKind = kind;
  if (active) filter.active = active === 'true';
  if (q) { const re = new RegExp(escapeRe(q), 'i'); filter.$or = [{ name: mongoose.trusted({ $regex: re }) }, { document: mongoose.trusted({ $regex: re }) }]; }
  const [list, counts] = await Promise.all([
    Therapist.find(filter).collation(ci).sort({ name: 1 }).lean(),
    scheduleCounts()
  ]);
  res.json(list.map(t => therapistDTO(t, counts.get(String(t._id)) ?? 0)));
}));

async function assertUnique(name: string, document: string, exceptId?: string) {
  const not = exceptId ? { _id: notId(exceptId) } : {};
  if (await Therapist.exists({ name, ...not }).collation(ci)) throw new HttpError(409, 'DUPLICATE', 'Ya existe una terapeuta con ese nombre.');
  if (document && (await Therapist.exists({ document, ...not }))) throw new HttpError(409, 'DUPLICATE', 'Ese documento ya está registrado.');
}

therapists.post('/', requireRole('admin'), h(async (req, res) => {
  const data = parse(therapistInputSchema, req.body);
  await assertUnique(data.name, data.document);
  const t: any = await Therapist.create({ ...data, document: data.document || undefined, serviceIds: await checkServices(data.serviceIds) });
  await audit(req, 'create', 'therapist', t._id, `Registró a ${t.name}`);
  res.status(201).json(therapistDTO(t));
}));

therapists.patch('/:id', requireRole('admin'), h(async (req, res) => {
  const id = idParam(req), data = parse(therapistInputSchema, req.body);
  const t: any = await Therapist.findById(id);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Terapeuta no encontrada');
  await assertUnique(data.name, data.document, id);
  t.set({ ...data, document: data.document || undefined, serviceIds: await checkServices(data.serviceIds) });
  await t.save();
  await audit(req, 'update', 'therapist', t._id, `Editó a ${t.name}`);
  res.json(therapistDTO(t, (await scheduleCounts([t._id])).get(String(t._id)) ?? 0));
}));

/** Una terapeuta que aparece en algún cuadro no se borra: se desactiva. */
therapists.delete('/:id', requireRole('admin'), h(async (req, res) => {
  const id = idParam(req);
  const t: any = await Therapist.findById(id);
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Terapeuta no encontrada');
  const n = (await scheduleCounts([t._id])).get(String(t._id)) ?? 0;
  if (n) throw new HttpError(409, 'IN_USE', `Aparece en ${n} cuadro(s). Para retirarla, desactívala.`);
  await t.deleteOne();
  await audit(req, 'delete', 'therapist', t._id, `Eliminó a ${t.name}`);
  res.status(204).end();
}));
