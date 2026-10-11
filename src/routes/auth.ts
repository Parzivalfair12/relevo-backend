import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { changePasswordSchema, loginSchema, registerSchema } from '../shared/index.js';
import { User } from '../models/index.js';
import { HttpError, authenticate } from '../middleware/index.js';
import { h, parse } from '../lib/http.js';
import { perUser, sameOriginOnly } from '../lib/limits.js';
import { audit } from '../lib/audit.js';
import { clearFailures, isLocked, registerFailure } from '../lib/lockout.js';
import { userDTO } from '../lib/dto.js';
import {
  DUMMY_HASH, MAX_SESSIONS, REFRESH_COOKIE, clearRefreshCookie, hashPassword, refreshCookie,
  signAccess, signRefresh, verifyPassword, verifyRefresh
} from '../lib/tokens.js';

const tooMany = { code: 'RATE_LIMIT', message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' };
/** Solo cuentan los intentos fallidos: entrar bien no gasta el límite. Uno por IP y otro por correo. */
const loginByIp = rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: tooMany });
const loginByEmail = rateLimit({
  windowMs: 15 * 60_000, limit: 8, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: tooMany,
  keyGenerator: req => `email:${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 200)}`
});
/** Cambiar la contraseña exige la actual: se limita por usuaria para que nadie la adivine desde una sesión abierta */
const passwordByUser = perUser(10, 15 * 60_000);
const registerByIp = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: tooMany });

export const auth = Router();

/** Guarda un token de renovación nuevo (máximo MAX_SESSIONS por usuario) y lo entrega en la cookie. */
async function startSession(res: Response, userId: string, epoch = 0) {
  const r = signRefresh(userId, epoch);
  await User.updateOne({ _id: userId }, { $push: { refreshTokens: { $each: [{ jti: r.jtiHash, exp: r.exp }], $slice: -MAX_SESSIONS } } });
  res.cookie(REFRESH_COOKIE, r.token, refreshCookie);
}

auth.post('/register', registerByIp, h(async (req, res) => {
  const { name, email, password } = parse(registerSchema, req.body);
  if (await User.exists({ email })) throw new HttpError(409, 'DUPLICATE', 'Ya existe una cuenta con ese correo.');
  // Las cuentas nuevas son coordinadoras sin servicios y quedan pendientes hasta que un administrador las apruebe
  await User.create({ name, email, passwordHash: await hashPassword(password), role: 'coord', status: 'pendiente', serviceIds: [] });
  res.status(201).json({ ok: true });
}));

auth.post('/login', loginByIp, loginByEmail, h(async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const u: any = await User.findOne({ email }).select('+passwordHash');
  const ok = await verifyPassword(u?.passwordHash ?? DUMMY_HASH, password);
  // Bloqueada: no entra ni con la contraseña correcta. Se responde como el límite de intentos para no delatar que la cuenta existe.
  if (u && isLocked(u)) throw new HttpError(429, tooMany.code, tooMany.message);
  if (!u || !ok) {
    if (u) await registerFailure(u);
    throw new HttpError(401, 'BAD_CREDENTIALS', 'Correo o contraseña incorrectos.');
  }
  if (u.failedLogins || u.lockedUntil) await clearFailures(u._id);
  if (u.status !== 'activo') throw new HttpError(403, 'PENDING', 'Tu cuenta está pendiente de aprobación por un administrador.');
  await startSession(res, String(u._id), u.tokenEpoch ?? 0);
  res.json({ accessToken: signAccess(String(u._id), u.role, u.tokenEpoch ?? 0), user: userDTO(u) });
}));

/** Rotación: cada token de renovación sirve una sola vez. Si llega uno ya usado, se cierran todas las sesiones de esa cuenta. */
auth.post('/refresh', sameOriginOnly, h(async (req, res) => {
  const fail = (): never => { res.clearCookie(REFRESH_COOKIE, clearRefreshCookie); throw new HttpError(401, 'UNAUTHENTICATED', 'La sesión venció'); };
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string') return fail();
  let p: { sub: string; jtiHash: string; ep: number };
  try { p = verifyRefresh(token); } catch { return fail(); }
  // Un token de una generación anterior (cambió la contraseña) no es un robo: simplemente ya no sirve, sin cerrar las demás sesiones
  const cur: any = await User.findById(p.sub).select('role status tokenEpoch');
  if (!cur || (cur.tokenEpoch ?? 0) !== p.ep) return fail();
  // Consumir es atómico: si dos peticiones llegan con el mismo token, solo una lo logra
  const used = await User.updateOne({ _id: p.sub, 'refreshTokens.jti': p.jtiHash }, { $pull: { refreshTokens: { jti: p.jtiHash } } });
  if (used.modifiedCount !== 1) {
    await User.updateOne({ _id: p.sub }, { $set: { refreshTokens: [] } }); // posible robo: se revocan todas
    return fail();
  }
  if (cur.status !== 'activo') return fail();
  await startSession(res, String(cur._id), cur.tokenEpoch ?? 0);
  res.json({ accessToken: signAccess(String(cur._id), cur.role, cur.tokenEpoch ?? 0) });
}));

auth.post('/logout', sameOriginOnly, h(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string') {
    try { const p = verifyRefresh(token); await User.updateOne({ _id: p.sub }, { $pull: { refreshTokens: { jti: p.jtiHash } } }); } catch { /* ya vencido */ }
  }
  res.clearCookie(REFRESH_COOKIE, clearRefreshCookie);
  res.status(204).end();
}));

/**
 * Cambiar la propia contraseña. Cierra las demás sesiones de la cuenta (otros navegadores o equipos) y deja abierta
 * la de quien la cambió. Un 400 y no un 401 si la actual está mal: un 401 haría que la web crea que la sesión venció.
 */
auth.post('/password', authenticate, passwordByUser, h(async (req, res) => {
  const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
  const u: any = await User.findById(req.user!.id).select('+passwordHash');
  if (!u || !(await verifyPassword(u.passwordHash, currentPassword))) throw new HttpError(400, 'BAD_PASSWORD', 'La contraseña actual no es correcta.');
  const now: any = await User.findOneAndUpdate({ _id: u._id },
    { $set: { passwordHash: await hashPassword(newPassword), refreshTokens: [], failedLogins: 0 }, $inc: { tokenEpoch: 1 }, $unset: { lockedUntil: 1, lastFailedAt: 1 } }, { new: true }).select('tokenEpoch role');
  await startSession(res, String(u._id), now.tokenEpoch);
  await audit(req, 'password', 'user', u._id, 'Cambió su propia contraseña');
  res.json({ ok: true, accessToken: signAccess(String(u._id), now.role, now.tokenEpoch) }); // las demás sesiones (renovación y acceso) dejan de valer
}));

auth.get('/me', authenticate, h(async (req, res) => {
  const u = await User.findById(req.user!.id).lean();
  res.json(userDTO(u));
}));
