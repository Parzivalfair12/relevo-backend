import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Ciudad que lleva el encabezado de los archivos exportados («NEIVA, SEPTIEMBRE 2026») */
  EXPORT_CITY: z.string().default('Neiva'),
  /**
   * Cuántos proxies hay delante de la API (por ejemplo 1 con Nginx). Sin esto, detrás de un proxy todas las
   * peticiones parecen venir de la misma IP y el límite de intentos por IP bloquearía a todos a la vez.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info')
});

/** Falla al arrancar si falta alguna variable (mejor que fallar en mitad de una petición). */
export const config = schema.parse(process.env);
export const isProd = config.NODE_ENV === 'production';
export const allowedOrigins = config.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);

/**
 * En producción no se arranca con la configuración de ejemplo: secretos copiados del `.env.example`,
 * repetidos o cortos, u orígenes sin HTTPS. Devuelve la lista de problemas (vacía si todo está bien).
 */
export function productionProblems(c: Pick<typeof config, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET' | 'CORS_ORIGIN'>): string[] {
  const out: string[] = [];
  for (const [name, v] of [['JWT_ACCESS_SECRET', c.JWT_ACCESS_SECRET], ['JWT_REFRESH_SECRET', c.JWT_REFRESH_SECRET]] as const) {
    if (/cambia-esto|secret|changeme|test-/i.test(v)) out.push(`${name} parece un valor de ejemplo: genera uno aleatorio (por ejemplo: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")`);
    if (v.length < 32) out.push(`${name} debe tener al menos 32 caracteres`);
  }
  if (c.JWT_ACCESS_SECRET === c.JWT_REFRESH_SECRET) out.push('JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos');
  for (const o of c.CORS_ORIGIN.split(',').map(x => x.trim()).filter(Boolean)) {
    if (o === '*') out.push('CORS_ORIGIN no puede ser «*»');
    else if (!/^https:\/\//.test(o) && !/^http:\/\/localhost(:\d+)?$/.test(o)) out.push(`CORS_ORIGIN «${o}» debe usar https (solo localhost puede ir con http)`);
  }
  return out;
}
if (isProd) {
  const problems = productionProblems(config);
  if (problems.length) { console.error('Configuración insegura para producción:\n - ' + problems.join('\n - ')); process.exit(1); }
}
