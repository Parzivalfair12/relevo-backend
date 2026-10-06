import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Role } from '../shared/index.js';
import { User } from '../models/index.js';
import { verifyAccess } from '../lib/tokens.js';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export interface AuthUser { id: string; role: Role; serviceIds: string[] }
declare global { namespace Express { interface Request { user?: AuthUser } } }

/** Formato único de error: { code, message, details } */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    // El primer mensaje ya está en español y la web lo muestra tal cual
    return res.status(400).json({ code: 'VALIDATION', message: err.issues[0]?.message ?? 'Datos inválidos', details: err.flatten() });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
  if ((err as { code?: number })?.code === 11000) return res.status(409).json({ code: 'DUPLICATE', message: 'Ya existe un registro con esos datos.' });
  if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'El contenido enviado es demasiado grande.' });
  if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ code: 'VALIDATION', message: 'JSON inválido' });
  logger.error({ err }, 'error interno');
  res.status(500).json({ code: 'INTERNAL', message: 'Error interno' });
}

export const notImplemented = (phase: string) => (_req: Request, _res: Response, next: NextFunction) =>
  next(new HttpError(501, 'NOT_IMPLEMENTED', `Pendiente: ${phase}`));

/**
 * Verifica el token de acceso y vuelve a leer al usuario: si lo eliminaron, lo desactivaron o le cambiaron el rol,
 * el cambio vale desde la siguiente petición y no hasta que venza el token.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return next(new HttpError(401, 'UNAUTHENTICATED', 'Inicia sesión para continuar'));
  let sub: string;
  try { sub = verifyAccess(m[1]).sub; } catch { return next(new HttpError(401, 'UNAUTHENTICATED', 'La sesión venció')); }
  User.findById(sub).select('role status serviceIds').lean().then((u: any) => {
    if (!u || u.status !== 'activo') return next(new HttpError(401, 'UNAUTHENTICATED', 'La sesión venció'));
    req.user = { id: String(u._id), role: u.role, serviceIds: (u.serviceIds ?? []).map(String) };
    next();
  }, next);
}

/** Exigir rol. Siempre se verifica aquí, nunca solo en la web. */
export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) =>
  next(req.user && roles.includes(req.user.role) ? undefined : new HttpError(403, 'FORBIDDEN', 'No tienes permiso para hacer esto'));
