import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { allowedOrigins, isProd } from '../config.js';
import { HttpError } from '../middleware/index.js';

const tooMany = { code: 'RATE_LIMIT', message: 'Demasiadas solicitudes seguidas. Espera unos minutos e inténtalo de nuevo.' };

/** Límite por usuaria (no por IP: varias coordinadoras pueden compartir la red del hospital). Va después de `authenticate`. */
export const perUser = (limit: number, windowMs = 10 * 60_000) =>
  rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: tooMany, keyGenerator: (req: Request) => `u:${req.user?.id ?? req.ip}` });

/** Archivos: leer o escribir una hoja de cálculo cuesta mucho más que una consulta. */
export const heavy = perUser(30);
/** Recalcular un cuadro corre el motor en un hilo aparte: se limita para que nadie lo sature. */
export const regen = perUser(240);

/**
 * Protección extra para las rutas que dependen de la cookie de renovación (renovar y salir): en producción,
 * si el navegador dice de qué página viene (Origin) y no es una de las permitidas, se rechaza. SameSite=Strict ya lo
 * impide en los navegadores modernos; esto cubre el resto. En desarrollo no se aplica (la web puede salir por cualquier puerto).
 */
export function sameOriginOnly(req: Request, _res: unknown, next: (e?: unknown) => void) {
  const origin = req.headers.origin;
  if (isProd && origin && !allowedOrigins.includes(origin)) return next(new HttpError(403, 'FORBIDDEN_ORIGIN', 'Origen no permitido'));
  next();
}
