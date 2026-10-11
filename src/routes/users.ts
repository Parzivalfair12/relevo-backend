import { Router } from 'express';
import { deleteUserQuerySchema, resetPasswordSchema, userCreateSchema, userInputSchema } from '../shared/index.js';
import { Schedule, User } from '../models/index.js';
import { HttpError, authenticate, requireRole } from '../middleware/index.js';
import { checkServices, h, idParam, parse } from '../lib/http.js';
import { userDTO } from '../lib/dto.js';
import { hashPassword } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';
import { clearFailures } from '../lib/lockout.js';

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

/**
 * Mientras no haya correo para recuperarla, el administrador fija una contraseña nueva a otra persona.
 * Cierra todas sus sesiones y le quita el bloqueo; la contraseña nunca se guarda en la auditoría.
 */
users.post('/:id/password', h(async (req, res) => {
  const id = idParam(req), { password } = parse(resetPasswordSchema, req.body);
  if (id === req.user!.id) throw new HttpError(403, 'FORBIDDEN', 'Usa «Cambiar mi contraseña» para tu propia cuenta.');
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  await User.updateOne({ _id: id }, { $set: { passwordHash: await hashPassword(password), refreshTokens: [], failedLogins: 0 }, $inc: { tokenEpoch: 1 }, $unset: { lockedUntil: 1, lastFailedAt: 1 } });
  await audit(req, 'password', 'user', u._id, `Restableció la contraseña de ${u.email}`);
  res.json({ ok: true });
}));

/** Quitar el bloqueo temporal de una cuenta sin esperar a que venza. */
users.post('/:id/unlock', h(async (req, res) => {
  const id = idParam(req);
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  await clearFailures(id);
  await audit(req, 'unlock', 'user', u._id, `Desbloqueó la cuenta de ${u.email}`);
  res.json(userDTO(await User.findById(id)));
}));

users.delete('/:id', h(async (req, res) => {
  const id = idParam(req);
  if (id === req.user!.id) throw new HttpError(403, 'FORBIDDEN', 'No puedes eliminar tu propia cuenta.');
  const { reassignTo } = parse(deleteUserQuerySchema, req.query);
  const u: any = await User.findById(id);
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'Usuario no encontrado');
  // Los cuadros guardan quién los creó: sin dueña la tarjeta mostraría «Creado por» vacío. Se pasan a otra persona o no se elimina.
  const owned = await Schedule.countDocuments({ ownerId: id });
  if (owned) {
    if (!reassignTo) throw new HttpError(409, 'OWNS_SCHEDULES', `Esta persona es dueña de ${owned} cuadro(s). Elige a quién pasárselos para poder eliminarla.`, { count: owned });
    if (reassignTo === id) throw new HttpError(400, 'VALIDATION', 'Elige a otra persona para pasarle los cuadros.');
    const heir = await User.exists({ _id: reassignTo, status: 'activo' });
    if (!heir) throw new HttpError(400, 'VALIDATION', 'La persona elegida no existe o no está activa.');
    await Schedule.updateMany({ ownerId: id }, { $set: { ownerId: reassignTo } });
  }
  await u.deleteOne();
  await audit(req, 'delete', 'user', u._id, `Eliminó el usuario ${u.email}${owned ? ` y pasó ${owned} cuadro(s) a otra persona` : ''}`);
  res.status(204).end();
}));
