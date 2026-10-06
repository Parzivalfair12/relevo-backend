import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { User } from '../src/models/index';
import { PW, app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
const cookieOf = (cookies?: string[]) => cookies?.find(c => c.startsWith('refresh_token='));
const cookieHeader = (cookies?: string[]) => (cookieOf(cookies) ?? '').split(';')[0];

beforeAll(async () => { await setupDb(); await makeFixtures(); });
afterAll(teardownDb);

describe('acceso', () => {
  it('entra con credenciales correctas y deja la cookie de renovación httpOnly y SameSite=Strict', async () => {
    const { res, cookies } = await login('admin@test.co');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@test.co', role: 'admin', status: 'activo' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshTokens/);
    const c = cookieOf(cookies)!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('responde igual con correo inexistente y con contraseña incorrecta', async () => {
    const a = await login('admin@test.co', 'otra-clave-123');
    const b = await login('nadie@test.co', 'otra-clave-123');
    expect(a.res.status).toBe(401); expect(b.res.status).toBe(401);
    expect(a.res.body.message).toBe(b.res.body.message);
  });

  it('el registro deja la cuenta pendiente y sin servicios; no puede entrar hasta que la aprueben', async () => {
    const r = await request(app).post(api('/auth/register')).send({ name: 'Nueva Persona', email: 'Nueva@Test.co', password: PW });
    expect(r.status).toBe(201);
    const u: any = await User.findOne({ email: 'nueva@test.co' });
    expect(u).toMatchObject({ role: 'coord', status: 'pendiente' });
    expect(u.serviceIds).toHaveLength(0);
    const l = await login('nueva@test.co');
    expect(l.res.status).toBe(403);
    expect(l.res.body.code).toBe('PENDING');
  });

  it('rechaza contraseñas cortas y correos repetidos al registrarse', async () => {
    const short = await request(app).post(api('/auth/register')).send({ name: 'Ana Pérez', email: 'ana@test.co', password: '1234567' });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/8 caracteres/);
    const dup = await request(app).post(api('/auth/register')).send({ name: 'Otra Admin', email: 'admin@test.co', password: PW });
    expect(dup.status).toBe(409);
  });

  it('exige token para /auth/me y rechaza uno inválido', async () => {
    expect((await request(app).get(api('/auth/me'))).status).toBe(401);
    expect((await request(app).get(api('/auth/me')).set(authed('basura'))).status).toBe(401);
    const { token } = await login('coord@test.co');
    const me = await request(app).get(api('/auth/me')).set(authed(token));
    expect(me.body).toMatchObject({ email: 'coord@test.co', role: 'coord' });
  });

  it('renueva la sesión rotando el token: el anterior ya no sirve y reutilizarlo cierra todas las sesiones', async () => {
    const { cookies } = await login('coord@test.co');
    const first = await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(cookies));
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    const newCookie = cookieHeader(first.headers['set-cookie'] as unknown as string[]);
    expect(newCookie).not.toBe(cookieHeader(cookies));
    // Se reusa el token viejo (posible robo): falla y revoca también el nuevo
    const reuse = await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(cookies));
    expect(reuse.status).toBe(401);
    const afterRevoke = await request(app).post(api('/auth/refresh')).set('Cookie', newCookie);
    expect(afterRevoke.status).toBe(401);
  });

  it('cierra sesión: el token de renovación deja de servir', async () => {
    const { cookies } = await login('coord@test.co');
    const out = await request(app).post(api('/auth/logout')).set('Cookie', cookieHeader(cookies));
    expect(out.status).toBe(204);
    expect((await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(cookies))).status).toBe(401);
  });

  it('un usuario eliminado pierde el acceso aunque su token de acceso siga vigente', async () => {
    const { token } = await login('coord@test.co');
    await User.deleteOne({ email: 'coord@test.co' });
    expect((await request(app).get(api('/auth/me')).set(authed(token))).status).toBe(401);
  });

  it('limita los intentos fallidos por correo', async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await login('limite@test.co', 'incorrecta-123')).res.status;
    expect(last).toBe(429);
  });
});
