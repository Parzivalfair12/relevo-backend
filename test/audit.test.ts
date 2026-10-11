import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuditLog, User } from '../src/models/index';
import { app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
const DAY = 86_400_000;
let admin: string, coord: string, adminId: string, coordId: string, ghostId: string;
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY + extraMs);
const list = (query: Record<string, unknown> = {}, token = admin) => request(app).get(api('/audit')).query(query).set(authed(token));

beforeAll(async () => {
  await setupDb(); const fx = await makeFixtures();
  adminId = String(fx.admin._id); coordId = String(fx.coord._id); ghostId = String(new mongoose.Types.ObjectId()); // una persona que ya no existe
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
  const e = (createdAt: Date, userId: string, action: string, entity: string, summary: string) =>
    AuditLog.create({ createdAt, userId, action, entity, entityId: new mongoose.Types.ObjectId(), summary });
  await e(ago(10), adminId, 'create', 'user', 'Creó el usuario ana@test.co (coord)');
  await e(ago(8), coordId, 'create', 'schedule', 'Creó el cuadro de UCI 10/2026');
  await e(ago(6), coordId, 'update', 'schedule', 'Cuadro 10/2026: publicó');
  await e(ago(4), adminId, 'delete', 'therapist', 'Eliminó a Beatriz (3 cuadro(s) afectados)');
  await e(ago(2), ghostId, 'update', 'service', 'Editó el servicio Urgencias');
  await e(ago(1), adminId, 'password', 'user', 'Restableció la contraseña de ana@test.co');
});
afterAll(teardownDb);

describe('consulta de auditoría', () => {
  it('es solo para administradores', async () => {
    expect((await request(app).get(api('/audit'))).status).toBe(401);
    expect((await list({}, coord)).status).toBe(403);
    expect((await request(app).post(api('/audit')).set(authed(admin)).send({ summary: 'x' })).status).toBe(404); // de solo lectura
    expect((await request(app).delete(api('/audit')).set(authed(admin))).status).toBe(404);
  });
  it('devuelve lo más reciente primero, con el nombre de quién lo hizo (o null si ya no existe)', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.summary)).toEqual([
      'Restableció la contraseña de ana@test.co', 'Editó el servicio Urgencias', 'Eliminó a Beatriz (3 cuadro(s) afectados)',
      'Cuadro 10/2026: publicó', 'Creó el cuadro de UCI 10/2026', 'Creó el usuario ana@test.co (coord)'
    ]);
    expect(r.body.items[0]).toMatchObject({ userId: adminId, userName: 'Admin Prueba', action: 'password', entity: 'user' });
    expect(r.body.items[1]).toMatchObject({ userId: ghostId, userName: null });
    expect(new Date(r.body.items[0].at).getTime()).toBeGreaterThan(new Date(r.body.items[5].at).getTime());
    expect(r.body.nextCursor).toBeNull();
  });
  it('filtra por tipo, acción y persona, y se pueden combinar', async () => {
    expect((await list({ entity: 'schedule' })).body.items).toHaveLength(2);
    expect((await list({ action: 'update' })).body.items).toHaveLength(2);
    expect((await list({ user: coordId })).body.items.map((i: any) => i.entity)).toEqual(['schedule', 'schedule']);
    expect((await list({ user: coordId, action: 'update' })).body.items).toHaveLength(1);
    expect((await list({ entity: 'user', user: coordId })).body.items).toHaveLength(0);
  });
  it('busca texto en el detalle sin distinguir mayúsculas y tomando los símbolos literalmente', async () => {
    expect((await list({ q: 'ANA@TEST.CO' })).body.items).toHaveLength(2);
    expect((await list({ q: 'cuadro(s)' })).body.items).toHaveLength(1); // los paréntesis no son una expresión regular
    const odd = await list({ q: '(' });
    expect(odd.status).toBe(200); expect(odd.body.items).toHaveLength(2); // «(coord)» y «(3 cuadro(s)…)»
    expect((await list({ q: '.*' })).body.items).toHaveLength(0);
  });
  it('filtra por rango de fechas, inclusivo', async () => {
    const r = await list({ from: ago(7).toISOString(), to: ago(3).toISOString() });
    expect(r.body.items.map((i: any) => i.action)).toEqual(['delete', 'update']);
    expect((await list({ from: ago(1.5).toISOString() })).body.items).toHaveLength(1);
    expect((await list({ to: ago(9).toISOString() })).body.items).toHaveLength(1);
  });
  it('rechaza filtros inválidos', async () => {
    for (const bad of [{ action: 'borrar' }, { entity: 'otra' }, { user: 'xyz' }, { from: 'ayer' }, { limit: 0 }, { limit: 201 }, { cursor: 'basura' }, { from: ago(1).toISOString(), to: ago(5).toISOString() }]) {
      expect([JSON.stringify(bad), (await list(bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
  });
});

describe('paginación', () => {
  it('recorre todo sin repetir ni saltar, aunque varios registros compartan la misma fecha', async () => {
    const same = ago(0, -5000); // 7 registros en el mismo instante
    for (let i = 0; i < 7; i++) await AuditLog.create({ createdAt: same, userId: adminId, action: 'update', entity: 'service', entityId: new mongoose.Types.ObjectId(), summary: `Empate ${i}` });
    const total = await AuditLog.countDocuments({});
    const seen: string[] = []; let cursor: string | undefined, pages = 0;
    do {
      const r = await list({ limit: 4, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200); expect(r.body.items.length).toBeLessThanOrEqual(4);
      seen.push(...r.body.items.map((i: any) => i.id)); cursor = r.body.nextCursor ?? undefined; pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(pages).toBe(Math.ceil(total / 4));
    const all = (await list({ limit: 200 })).body.items;
    expect(seen).toEqual(all.map((i: any) => i.id)); // el mismo orden que sin paginar
  });
  it('la última página no trae cursor y una página exacta tampoco inventa otra', async () => {
    const total = await AuditLog.countDocuments({});
    const r = await list({ limit: total });
    expect(r.body.items).toHaveLength(total); expect(r.body.nextCursor).toBeNull();
  });
});

describe('plazo de conservación', () => {
  it('informa los días configurados y el índice de caducidad existe', async () => {
    expect((await list()).body.retentionDays).toBe(400);
    const idx = await AuditLog.collection.indexes();
    const ttl = idx.find((i: any) => i.expireAfterSeconds !== undefined);
    expect(ttl).toMatchObject({ key: { createdAt: 1 }, expireAfterSeconds: 400 * 86_400 });
    expect(idx.some((i: any) => JSON.stringify(i.key) === JSON.stringify({ createdAt: -1, _id: -1 }))).toBe(true);
  });
  it('lo que se hace de verdad en la API queda en el registro', async () => {
    const r = await request(app).post(api('/services')).set(authed(admin)).send({ name: 'Servicio Nuevo Prueba', color: '#2BB3BD' });
    expect(r.status).toBe(201);
    const found = await list({ entity: 'service', action: 'create' });
    expect(found.body.items[0]).toMatchObject({ userName: 'Admin Prueba', summary: expect.stringContaining('Servicio Nuevo Prueba') });
    expect(await User.countDocuments({})).toBeGreaterThan(0);
  });
});
