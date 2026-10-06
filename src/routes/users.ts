import { Router } from 'express';
import { userCreateSchema, userInputSchema } from '../shared/index.js';
import { User } from '../models/index.js';
import { HttpError, authenticate, requireRole } from '../middleware/index.js';
import { checkServices, h, idParam, parse } from '../lib/http.js';
import { userDTO } from '../lib/dto.js';
import { hashPassword } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';

/** Todo /users es solo para administradores. */
export const users = Router();
users.use(authenticate, requireRole('admin'));

const dupEmail = () => new HttpError(409, 'DUPLICATE', 'Ese correo ya tiene una cuenta.');

users.get('/', h(async (_req, res) => {
  res.json((await User.find().sort({ createdAt: 1, _id: 1 }).lean()).map(userDTO));
}));

users.post('/', h(async (req, res) => {
  const { password, ...data } = parse(userCreateSchema, req.body);
  if (await User.exists({ email: data.email })) throw dupEmail();
  const serviceIds = data.role === 'admin' ? [] : await checkServices(data.serviceIds);
  const u = await User.create({ ...data, serviceIds, status: 'activo', passwordHash: await hashPassword(password) });
  await audit(req, 'create', 'user', u._id, `Creó el usuario ${u.email} (${u.role})`);
  res.status(201).json(userDTO(u));
}));

/** Editar un usuario ya activo (o dejar pendiente a uno pendiente). */
users.patch('/:id', h(async (req, res) => {
  const id = idParam(req), data = parse(userInputSchema, req.body);
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  // Como nadie puede cambiar su propio rol ni borrarse, siempre queda al menos un administrador (el que actúa)
  if (u.role !== data.role && id === req.user!.id) throw new HttpError(403, 'FORBIDDEN', 'No puedes cambiar tu propio rol.');
  if (data.email !== u.email && (await User.exists({ email: data.email }))) throw dupEmail();
  u.set({ name: data.name, email: data.email, role: data.role, serviceIds: data.role === 'admin' ? [] : await checkServices(data.serviceIds) });
  await u.save();
  await audit(req, 'update', 'user', u._id, `Editó el usuario ${u.email} (${u.role})`);
  res.json(userDTO(u));
}));

/** Aprobar una solicitud pendiente: asigna rol y servicios y activa la cuenta. */
users.post('/:id/approve', h(async (req, res) => {
  const id = idParam(req), data = parse(userInputSchema, req.body);
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  if (u.status !== 'pendiente') throw new HttpError(409, 'NOT_PENDING', 'Esta solicitud ya fue atendida.');
  if (data.email !== u.email && (await User.exists({ email: data.email }))) throw dupEmail();
  u.set({ name: data.name, email: data.email, role: data.role, status: 'activo', serviceIds: data.role === 'admin' ? [] : await checkServices(data.serviceIds) });
  await u.save();
  await audit(req, 'approve', 'user', u._id, `Aprobó el acceso de ${u.email} como ${u.role}`);
  res.json(userDTO(u));
}));

users.delete('/:id', h(async (req, res) => {
  const id = idParam(req);
  if (id === req.user!.id) throw new HttpError(403, 'FORBIDDEN', 'No puedes eliminar tu propia cuenta.');
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  await u.deleteOne();
  await audit(req, 'delete', 'user', u._id, `Eliminó el usuario ${u.email}`);
  res.status(204).end();
}));
