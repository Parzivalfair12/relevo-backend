import { Router } from 'express';
import mongoose from 'mongoose';
import { auditQuerySchema, type AuditEntryDTO, type AuditPageDTO } from '../shared/index.js';
import { config } from '../config.js';
import { AuditLog, User } from '../models/index.js';
import { HttpError, authenticate, requireRole } from '../middleware/index.js';
import { escapeRe, h, parse } from '../lib/http.js';

/** Registro de auditoría: solo lo lee el administrador. Es de solo lectura (nadie lo edita ni lo borra desde la API). */
export const audit = Router();
audit.use(authenticate, requireRole('admin'));

/** El cursor es «fecha.id» del último registro de la página anterior (codificado), para seguir justo después. */
const encodeCursor = (at: Date, id: unknown) => Buffer.from(`${at.getTime()}.${String(id)}`).toString('base64url');
function decodeCursor(c: string): { at: Date; id: mongoose.Types.ObjectId } {
  const [ms, id] = Buffer.from(c, 'base64url').toString().split('.');
  if (!/^\d{1,15}$/.test(ms ?? '') || !mongoose.isValidObjectId(id) || String(id).length !== 24) throw new HttpError(400, 'VALIDATION', 'El cursor no es válido.');
  return { at: new Date(Number(ms)), id: new mongoose.Types.ObjectId(id) };
}

audit.get('/', h(async (req, res) => {
  const q = parse(auditQuerySchema, req.query);
  const filter: Record<string, unknown> = {}, and: unknown[] = [];
  if (q.entity) filter.entity = q.entity;
  if (q.action) filter.action = q.action;
  if (q.user) filter.userId = q.user;
  if (q.from || q.to) and.push({ createdAt: mongoose.trusted({ ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) }) });
  if (q.q) and.push({ summary: mongoose.trusted({ $regex: new RegExp(escapeRe(q.q), 'i') }) });
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    and.push({ $or: [{ createdAt: mongoose.trusted({ $lt: c.at }) }, { createdAt: c.at, _id: mongoose.trusted({ $lt: c.id }) }] });
  }
  if (and.length) filter.$and = and;

  const rows = (await AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean()) as any[];
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;

  const ids = [...new Set(page.map(r => r.userId && String(r.userId)).filter(Boolean))] as string[];
  const names = new Map((await User.find({ _id: mongoose.trusted({ $in: ids }) }).select('name').lean()).map((u: any) => [String(u._id), u.name as string]));
  const items: AuditEntryDTO[] = page.map(r => ({
    id: String(r._id), at: new Date(r.createdAt).toISOString(), userId: r.userId ? String(r.userId) : null, userName: r.userId ? names.get(String(r.userId)) ?? null : null,
    action: r.action, entity: r.entity, entityId: r.entityId ? String(r.entityId) : null, summary: r.summary ?? ''
  }));
  const body: AuditPageDTO = { items, nextCursor: more ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1]._id) : null, retentionDays: config.AUDIT_RETENTION_DAYS };
  res.json(body);
}));
