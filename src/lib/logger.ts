import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import { config } from '../config.js';

/** Registros en JSON. Nunca llevan contraseñas, tokens ni cookies, ni documentos de las terapeutas. */
export const loggerOptions: pino.LoggerOptions = {
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.passwordHash', '*.accessToken', '*.document'], censor: '[oculto]' }
};
export const logger = pino({ ...loggerOptions, level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL });

/** Una línea por petición: método, ruta (sin consulta), estado, milisegundos y quién fue. /health no se registra. */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/v1/health' || req.originalUrl.startsWith('/api/v1/health')) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({ method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms), user: req.user?.id, ip: req.ip }, 'petición');
  });
  next();
}
