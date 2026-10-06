import { createHash, randomUUID } from 'node:crypto';
import type { CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { config, isProd } from '../config.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REFRESH_COOKIE = 'refresh_token';
export const MAX_SESSIONS = 5; // sesiones de renovación vigentes por usuario

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);
/** Hash válido pero sin dueño: se verifica cuando el correo no existe para que el tiempo de respuesta no delate cuentas. */
export const DUMMY_HASH = await hashPassword('turnos-dummy-password');

export const signAccess = (userId: string, role: string) =>
  jwt.sign({ role }, config.JWT_ACCESS_SECRET, { subject: userId, expiresIn: ACCESS_TTL_SECONDS, algorithm: 'HS256' });
export function verifyAccess(token: string): { sub: string } {
  const p = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  if (typeof p === 'string' || !p.sub) throw new Error('token inválido');
  return { sub: p.sub };
}

/** El token de renovación es un JWT con un jti aleatorio; en la base solo se guarda el hash del jti. */
export const hashJti = (jti: string) => createHash('sha256').update(jti).digest('hex');
export function signRefresh(userId: string) {
  const jti = randomUUID();
  const token = jwt.sign({}, config.JWT_REFRESH_SECRET, { subject: userId, jwtid: jti, expiresIn: REFRESH_TTL_SECONDS, algorithm: 'HS256' });
  return { token, jtiHash: hashJti(jti), exp: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000) };
}
export function verifyRefresh(token: string): { sub: string; jtiHash: string } {
  const p = jwt.verify(token, config.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  if (typeof p === 'string' || !p.sub || !p.jti) throw new Error('token inválido');
  return { sub: p.sub, jtiHash: hashJti(p.jti) };
}

/** httpOnly + SameSite=Strict siempre; Secure en producción (el navegador no guarda cookies Secure sobre http en desarrollo). */
export const refreshCookie: CookieOptions = {
  httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/v1/auth', maxAge: REFRESH_TTL_SECONDS * 1000
};
export const clearRefreshCookie: CookieOptions = { ...refreshCookie, maxAge: undefined };
