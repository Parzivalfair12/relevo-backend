import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AuditLog, User } from '../src/models/index';
import { hashPassword } from '../src/lib/tokens';
import { LOCK_AFTER } from '../src/lib/lockout';
import { PW, app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
const cookieHeader = (cookies?: string[]) => (cookies?.find(c => c.startsWith('refresh_token=')) ?? '').split(';')[0];
const NEW = 'clave-nueva-456';
let admin: string;

const mk = async (email: string, role: 'admin' | 'coord' = 'coord') =>
  User.create({ name: `Persona ${email}`, email, role, status: 'activo', serviceIds: [], passwordHash: await hashPassword(PW) });
const wrong = (email: string) => login(email, 'incorrecta-999');

beforeAll(async () => { await setupDb(); await makeFixtures(); admin = (await login('admin@test.co')).token; });
afterAll(teardownDb);

describe('cambiar la propia contraseña', () => {
  it('exige la actual (400, no 401), una nueva distinta y de al menos 8 caracteres', async () => {
    await mk('cambio@test.co');
    const { token } = await login('cambio@test.co');
    const post = (body: object) => request(app).post(api('/auth/password')).set(authed(token)).send(body);
    const bad = await post({ currentPassword: 'no-es-esta-1', newPassword: NEW });
    expect(bad.status).toBe(400); expect(bad.body.message).toBe('La contraseña actual no es correcta.');
    expect((await post({ currentPassword: PW, newPassword: PW })).body.message).toMatch(/distinta de la actual/);
    expect((await post({ currentPassword: PW, newPassword: '1234567' })).body.message).toMatch(/8 caracteres/);
    expect((await request(app).post(api('/auth/password')).send({ currentPassword: PW, newPassword: NEW })).status).toBe(401);
  });

  it('cambia la clave, cierra las demás sesiones y deja abierta la actual', async () => {
    await mk('sesiones@test.co');
    const a = await login('sesiones@test.co'), b = await login('sesiones@test.co'); // dos navegadores
    const r = await request(app).post(api('/auth/password')).set(authed(a.token)).send({ currentPassword: PW, newPassword: NEW });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(NEW);
    expect((await request(app).get(api('/auth/me')).set(authed(b.token))).status).toBe(401);          // el acceso de la otra sesión ya no vale
    expect((await request(app).get(api('/auth/me')).set(authed(r.body.accessToken))).status).toBe(200); // el de quien cambió la clave sí
    expect((await login('sesiones@test.co', PW)).res.status).toBe(401);          // la vieja ya no entra
    expect((await login('sesiones@test.co', NEW)).res.status).toBe(200);          // la nueva sí
    expect((await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(b.cookies))).status).toBe(401); // la otra sesión se cerró
    expect((await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(r.headers['set-cookie'] as unknown as string[]))).status).toBe(200); // esta sigue
    const log = await AuditLog.findOne({ summary: 'Cambió su propia contraseña' });
    expect(log).toBeTruthy();
    expect(JSON.stringify(await AuditLog.find().lean())).not.toContain(NEW);
  });
});

describe('bloqueo temporal por intentos fallidos', () => {
  it(`tras ${LOCK_AFTER} fallos no entra ni con la contraseña correcta, y responde como el límite de intentos`, async () => {
    await mk('bloqueo@test.co');
    for (let i = 0; i < LOCK_AFTER; i++) expect((await wrong('bloqueo@test.co')).res.status).toBe(401);
    const locked = await login('bloqueo@test.co', PW);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.message).toBe('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    const u: any = await User.findOne({ email: 'bloqueo@test.co' });
    expect(u.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    const list = await request(app).get(api('/users')).set(authed(admin));
    expect(list.body.find((x: any) => x.email === 'bloqueo@test.co').lockedUntil).toBeTruthy();
    expect(list.body.find((x: any) => x.email === 'admin@test.co').lockedUntil).toBeNull();
  });
  it('vencido el bloqueo vuelve a entrar y se borra el rastro', async () => {
    await User.updateOne({ email: 'bloqueo@test.co' }, { lockedUntil: new Date(Date.now() - 1000) });
    expect((await login('bloqueo@test.co', PW)).res.status).toBe(200);
    const u: any = await User.findOne({ email: 'bloqueo@test.co' });
    expect(u.lockedUntil).toBeUndefined(); expect(u.failedLogins).toBe(0);
  });
  it('entrar bien reinicia la cuenta de fallos', async () => {
    await mk('racha@test.co');
    for (let i = 0; i < LOCK_AFTER - 1; i++) await wrong('racha@test.co');
    expect(((await User.findOne({ email: 'racha@test.co' })) as any).failedLogins).toBe(LOCK_AFTER - 1);
    expect((await login('racha@test.co', PW)).res.status).toBe(200);
    expect(((await User.findOne({ email: 'racha@test.co' })) as any).failedLogins).toBe(0);
  });
  it('los fallos viejos no se acumulan con los de hoy', async () => {
    await mk('viejo@test.co');
    await User.updateOne({ email: 'viejo@test.co' }, { failedLogins: LOCK_AFTER - 1, lastFailedAt: new Date(Date.now() - 3600_000) }); // 4 fallos de hace una hora
    await wrong('viejo@test.co'); // el de hoy no se suma a los viejos: no se bloquea
    const u: any = await User.findOne({ email: 'viejo@test.co' });
    expect(u.failedLogins).toBe(1); expect(u.lockedUntil).toBeUndefined();
  });
  it('un correo que no existe no deja rastro ni se bloquea', async () => {
    for (let i = 0; i < 2; i++) expect((await wrong('fantasma@test.co')).res.status).toBe(401);
  });
});

describe('el administrador restablece y desbloquea', () => {
  it('fija una contraseña nueva, cierra las sesiones de esa persona y le quita el bloqueo', async () => {
    const u: any = await mk('reset@test.co');
    const s = await login('reset@test.co');
    await User.updateOne({ _id: u._id }, { failedLogins: 2, lockedUntil: new Date(Date.now() + 600_000) });
    expect((await login('reset@test.co', PW)).res.status).toBe(429);
    const r = await request(app).post(api(`/users/${u._id}/password`)).set(authed(admin)).send({ password: NEW });
    expect(r.status).toBe(200);
    expect((await login('reset@test.co', NEW)).res.status).toBe(200);              // el bloqueo se fue y la nueva sirve
    expect((await login('reset@test.co', PW)).res.status).toBe(401);
    expect((await request(app).post(api('/auth/refresh')).set('Cookie', cookieHeader(s.cookies))).status).toBe(401); // sesión anterior cerrada
    expect((await request(app).get(api('/auth/me')).set(authed(s.token))).status).toBe(401);
    expect(await AuditLog.countDocuments({ summary: 'Restableció la contraseña de reset@test.co' })).toBe(1);
    expect(JSON.stringify(await AuditLog.find().lean())).not.toContain(NEW);
  });
  it('valida la contraseña, no se usa sobre la propia cuenta y es solo para administradores', async () => {
    const u: any = await mk('objetivo@test.co');
    const self: any = await User.findOne({ email: 'admin@test.co' });
    expect((await request(app).post(api(`/users/${u._id}/password`)).set(authed(admin)).send({ password: '123' })).status).toBe(400);
    const own = await request(app).post(api(`/users/${self._id}/password`)).set(authed(admin)).send({ password: NEW });
    expect(own.status).toBe(403); expect(own.body.message).toMatch(/Cambiar mi contraseña/);
    const coord = (await login('objetivo@test.co')).token;
    expect((await request(app).post(api(`/users/${u._id}/password`)).set(authed(coord)).send({ password: NEW })).status).toBe(403);
    expect((await request(app).post(api(`/users/${u._id}/unlock`)).set(authed(coord))).status).toBe(403);
    expect((await request(app).post(api('/users/aaaaaaaaaaaaaaaaaaaaaaaa/password')).set(authed(admin)).send({ password: NEW })).status).toBe(404);
  });
  it('desbloquea una cuenta sin cambiar su contraseña', async () => {
    const u: any = await mk('desbloqueo@test.co');
    await User.updateOne({ _id: u._id }, { lockedUntil: new Date(Date.now() + 600_000) });
    const r = await request(app).post(api(`/users/${u._id}/unlock`)).set(authed(admin));
    expect(r.status).toBe(200); expect(r.body.lockedUntil).toBeNull();
    expect((await login('desbloqueo@test.co', PW)).res.status).toBe(200);
  });
});
