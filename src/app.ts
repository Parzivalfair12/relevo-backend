import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { allowedOrigins, config, isProd } from './config.js';
import { api } from './routes/index.js';
import { errorHandler } from './middleware/index.js';
import { requestLog } from './lib/logger.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Detrás de Nginx u otro proxy la IP real viene en X-Forwarded-For; sin proxy se ignora (así nadie la falsifica)
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(requestLog);
  app.use(helmet({
    // La API solo devuelve JSON y archivos: no necesita cargar nada ni dejarse enmarcar
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    strictTransportSecurity: isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  // Límite general por IP; el inicio de sesión y las rutas pesadas tienen los suyos más estrictos
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/v1', api);
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Ruta no encontrada' }));
  app.use(errorHandler);
  return app;
}
