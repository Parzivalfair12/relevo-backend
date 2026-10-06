import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { closeGenerator } from './lib/generate.js';
import { logger } from './lib/logger.js';

await connectDb();
const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT, env: config.NODE_ENV }, `API lista en http://localhost:${config.PORT}/api/v1/health`));

/**
 * Cierre ordenado (Docker y los orquestadores mandan SIGTERM): deja de aceptar peticiones, espera las que están
 * en curso, cierra el generador y la base, y sale. Si algo se cuelga, a los 15 s sale igual.
 */
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'cerrando');
  setTimeout(() => { logger.error('cierre forzado'); process.exit(1); }, 15_000).unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeGenerator();
  await disconnectDb();
  process.exit(0);
}
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { void shutdown(s); });
process.on('unhandledRejection', err => logger.error({ err }, 'promesa sin atender'));
