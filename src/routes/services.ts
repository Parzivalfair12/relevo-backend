import { Router } from 'express';
import { SERVICE_COLORS, serviceInputSchema } from '../shared/index.js';
import { Schedule, Service, Therapist, User } from '../models/index.js';
import { HttpError, authenticate, requireRole } from '../middleware/index.js';
import { ci, h, idParam, notId, parse } from '../lib/http.js';
import { serviceDTO } from '../lib/dto.js';
import { audit } from '../lib/audit.js';

export const services = Router();
services.use(authenticate);

const dupName = () => new HttpError(409, 'DUPLICATE', 'Ese servicio ya existe');
const nameTaken = (name: string, exceptId?: string) =>
  Service.exists({ name, ...(exceptId ? { _id: notId(exceptId) } : {}) }).collation(ci);

/** Lectura para todos los usuarios; los conteos (cuadros y terapeutas) solo los pide la pantalla de administración. */
services.get('/', h(async (req, res) => {
  const list = await Service.find().sort({ _id: 1 }).lean();
  if (req.user!.role !== 'admin') return res.json(list.map(s => serviceDTO(s)));
  const [sch, ther] = await Promise.all([
    Schedule.aggregate([{ $group: { _id: '$serviceId', n: { $sum: 1 } } }]),
    Therapist.aggregate([{ $unwind: '$serviceIds' }, { $group: { _id: '$serviceIds', n: { $sum: 1 } } }])
  ]);
  const count = (rows: { _id: unknown; n: number }[], id: unknown) => rows.find(r => String(r._id) === String(id))?.n ?? 0;
  res.json(list.map(s => serviceDTO(s, { schedules: count(sch, s._id), therapists: count(ther, s._id) })));
}));

services.post('/', requireRole('admin'), h(async (req, res) => {
  const data = parse(serviceInputSchema, req.body);
  if (await nameTaken(data.name)) throw dupName();
  // Sin color explícito se toma el siguiente de la paleta, como en el mockup
  const color = data.color ?? SERVICE_COLORS[(await Service.countDocuments()) % SERVICE_COLORS.length];
  const s = await Service.create({ name: data.name, color });
  await audit(req, 'create', 'service', s._id, `Creó el servicio ${s.name}`);
  res.status(201).json(serviceDTO(s));
}));

services.patch('/:id', requireRole('admin'), h(async (req, res) => {
  const id = idParam(req), data = parse(serviceInputSchema, req.body);
  const s: any = await Service.findById(id);
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Servicio no encontrado');
  if (await nameTaken(data.name, id)) throw dupName();
  s.name = data.name; if (data.color) s.color = data.color;
  await s.save();
  await audit(req, 'update', 'service', s._id, `Editó el servicio ${s.name}`);
  res.json(serviceDTO(s));
}));

services.delete('/:id', requireRole('admin'), h(async (req, res) => {
  const id = idParam(req);
  const s: any = await Service.findById(id);
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Servicio no encontrado');
  const n = await Schedule.countDocuments({ serviceId: id });
  if (n) throw new HttpError(409, 'IN_USE', `El servicio tiene ${n} cuadro(s) y no se puede eliminar.`);
  await s.deleteOne();
  // Igual que el mockup: se retira de usuarios y terapeutas
  await Promise.all([User.updateMany({}, { $pull: { serviceIds: s._id } }), Therapist.updateMany({}, { $pull: { serviceIds: s._id } })]);
  await audit(req, 'delete', 'service', s._id, `Eliminó el servicio ${s.name}`);
  res.status(204).end();
}));
