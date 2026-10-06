import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { productionProblems } from '../src/config';
import { loggerOptions } from '../src/lib/logger';
import { Schedule, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
const good = { JWT_ACCESS_SECRET: 'Xk3v9QmZ7rT2bW8nLp4sD6fGh1jKc5yA0eUiO3tRq', JWT_REFRESH_SECRET: 'Pw8Nz2LxC6vB4mQ1hJd9sF5gT7yUa3KeR0iOc8Vb', CORS_ORIGIN: 'https://turnos.hospital.co' };

describe('configuración de producción', () => {
  it('acepta secretos largos, distintos y orígenes con https (o localhost)', () => {
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ ...good, CORS_ORIGIN: 'https://a.co, http://localhost:8080' })).toEqual([]);
  });
  it('rechaza los valores de ejemplo, los secretos repetidos o cortos y los orígenes sin https', () => {
    expect(productionProblems({ ...good, JWT_ACCESS_SECRET: 'cambia-esto-por-un-secreto-largo-de-32-caracteres-o-mas' }).join(' ')).toMatch(/JWT_ACCESS_SECRET parece un valor de ejemplo/);
    expect(productionProblems({ ...good, JWT_REFRESH_SECRET: good.JWT_ACCESS_SECRET }).join(' ')).toMatch(/deben ser distintos/);
    expect(productionProblems({ ...good, JWT_ACCESS_SECRET: 'corto' }).join(' ')).toMatch(/al menos 32/);
    expect(productionProblems({ ...good, CORS_ORIGIN: 'http://turnos.hospital.co' }).join(' ')).toMatch(/debe usar https/);
    expect(productionProblems({ ...good, CORS_ORIGIN: '*' }).join(' ')).toMatch(/no puede ser/);
  });
});

describe('cabeceras y estado', () => {
  it('la API responde con cabeceras de seguridad y sin delatar el servidor', async () => {
    const r = await request(app).get(api('/health'));
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeUndefined(); // solo en producción (HTTPS)
  });
  it('/health/ready confirma la conexión con la base', async () => {
    await setupDb();
    const r = await request(app).get(api('/health/ready'));
    expect(r.status).toBe(200); expect(r.body).toEqual({ ok: true, db: 'up' });
  });
  it('un cuerpo JSON mal formado es 400 y uno demasiado grande no pasa', async () => {
    const bad = await request(app).post(api('/auth/login')).set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400); expect(bad.body.code).toBe('VALIDATION');
    const big = await request(app).post(api('/auth/login')).send({ email: 'a@b.co', password: 'x'.repeat(1_200_000) });
    expect(big.status).toBe(413);
  });
});

describe('registros sin datos sensibles', () => {
  it('ocultan tokens, cookies, contraseñas y documentos', () => {
    let out = '';
    const log = pino({ ...loggerOptions, level: 'info' }, new Writable({ write(c, _e, cb) { out += c; cb(); } }));
    log.info({ req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'refresh_token=zzz' } }, body: { password: 'miClave123', document: '1075000000' }, user: { passwordHash: '$argon2id$x' } }, 'prueba');
    for (const secreto of ['abc.def.ghi', 'refresh_token=zzz', 'miClave123', '1075000000', '$argon2id$x']) expect(out).not.toContain(secreto);
    expect(out).toContain('[oculto]');
  });
});

describe('protección del origen en renovar y salir', () => {
  it('en producción rechaza un Origin que no está permitido; sin Origin o permitido sigue', async () => {
    vi.resetModules();
    vi.doMock('../src/config', async () => ({ ...(await vi.importActual<object>('../src/config')), isProd: true, allowedOrigins: ['https://turnos.hospital.co'] }));
    const { sameOriginOnly } = await import('../src/lib/limits');
    const run = (origin?: string) => { let err: any; sameOriginOnly({ headers: origin ? { origin } : {} } as never, null, e => { err = e; }); return err; };
    expect(run('https://malo.example')).toMatchObject({ status: 403, code: 'FORBIDDEN_ORIGIN' });
    expect(run('https://turnos.hospital.co')).toBeUndefined();
    expect(run()).toBeUndefined();
    vi.doUnmock('../src/config'); vi.resetModules();
  });
});

describe('límite de archivos por usuaria', () => {
  let sched: any, admin: string;
  beforeAll(async () => {
    await setupDb(); const fx = await makeFixtures();
    const t = await Promise.all(['Ana Uno', 'Bea Dos'].map(name => Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [fx.uci._id] })));
    sched = await Schedule.create({ serviceId: fx.uci._id, year: 2026, month: 8, ownerId: fx.admin._id, members: t.map(x => ({ therapistId: x._id, kind: 'fija', days: Array(30).fill('L'), locked: [] })) });
    admin = (await login('admin@test.co')).token;
  });
  afterAll(teardownDb);
  it('la exportación 31 de una usuaria en 10 minutos responde 429 con mensaje claro', async () => {
    const get = () => request(app).get(api(`/schedules/${sched._id}/export?format=xlsx`)).set(authed(admin)).buffer(true).parse((res, cb) => { res.on('data', () => {}); res.on('end', () => cb(null, Buffer.alloc(0))); });
    for (let i = 0; i < 30; i++) expect((await get()).status).toBe(200);
    const r = await request(app).get(api(`/schedules/${sched._id}/export?format=xlsx`)).set(authed(admin));
    expect(r.status).toBe(429); expect(r.body.code).toBe('RATE_LIMIT'); expect(r.body.message).toMatch(/Espera unos minutos/);
  }, 60_000);
  it('un archivo de más de 8 MB se rechaza con 413 antes de leerlo', async () => {
    const coord = (await login('coord@test.co')).token; // otra usuaria: el límite de archivos de admin ya se agotó arriba
    const r = await request(app).post(api(`/schedules/import/preview?serviceId=${sched.serviceId}`)).set(authed(coord)).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(9 * 1024 * 1024));
    expect(r.status).toBe(413); expect(r.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
