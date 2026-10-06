import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AuditLog, Schedule, Therapist, User } from '../src/models/index';
import { app, authed, login, makeFixtures, oid, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string;

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(teardownDb);

const therapist = (over: Record<string, unknown> = {}) => ({
  name: 'Paula Torres', document: '1075111222', position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [String(fx.uci._id)], active: true, ...over
});

describe('permisos por rol', () => {
  it('sin sesión todo responde 401', async () => {
    for (const p of ['/users', '/services', '/therapists']) expect((await request(app).get(api(p))).status).toBe(401);
  });
  it('la coordinadora no entra a /users ni escribe en servicios o terapeutas (403)', async () => {
    expect((await request(app).get(api('/users')).set(authed(coord))).status).toBe(403);
    expect((await request(app).post(api('/services')).set(authed(coord)).send({ name: 'Nuevo servicio' })).status).toBe(403);
    expect((await request(app).post(api('/therapists')).set(authed(coord)).send(therapist())).status).toBe(403);
    expect((await request(app).delete(api(`/therapists/${oid()}`)).set(authed(coord))).status).toBe(403);
  });
  it('la coordinadora sí consulta servicios y directorio, y no recibe conteos de administración', async () => {
    const s = await request(app).get(api('/services')).set(authed(coord));
    expect(s.status).toBe(200); expect(s.body).toHaveLength(2);
    expect(s.body[0]).not.toHaveProperty('scheduleCount');
    expect((await request(app).get(api('/therapists')).set(authed(coord))).status).toBe(200);
  });
  it('un id mal formado es 404 y un cuerpo con operadores de Mongo se rechaza', async () => {
    expect((await request(app).patch(api('/services/no-es-un-id')).set(authed(admin)).send({ name: 'Algo válido' })).status).toBe(404);
    const r = await request(app).post(api('/auth/login')).send({ email: { $ne: '' }, password: { $ne: '' } });
    expect(r.status).toBe(400);
  });
});

describe('servicios', () => {
  it('crea con color de la paleta, renombra, impide duplicados y elimina', async () => {
    const c = await request(app).post(api('/services')).set(authed(admin)).send({ name: 'Urgencias' });
    expect(c.status).toBe(201);
    expect(c.body.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect((await request(app).post(api('/services')).set(authed(admin)).send({ name: 'urgencias' })).status).toBe(409);
    const u = await request(app).patch(api(`/services/${c.body.id}`)).set(authed(admin)).send({ name: 'Urgencias adultos', color: '#7C8CE0' });
    expect(u.body).toMatchObject({ name: 'Urgencias adultos', color: '#7C8CE0' });
    expect((await request(app).delete(api(`/services/${c.body.id}`)).set(authed(admin))).status).toBe(204);
  });
  it('no elimina un servicio con cuadros (409) y lo retira de usuarios y terapeutas al borrarlo', async () => {
    const withSchedule = await request(app).post(api('/services')).set(authed(admin)).send({ name: 'Con cuadros' });
    await Schedule.create({ serviceId: withSchedule.body.id, year: 2026, month: 9, ownerId: fx.admin._id });
    expect((await request(app).delete(api(`/services/${withSchedule.body.id}`)).set(authed(admin))).status).toBe(409);
    await Schedule.deleteMany({});
    const tmp = await request(app).post(api('/services')).set(authed(admin)).send({ name: 'Temporal' });
    const t = await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ name: 'Ana Temporal', document: '', serviceIds: [tmp.body.id, String(fx.uci._id)] }));
    await request(app).delete(api(`/services/${tmp.body.id}`)).set(authed(admin));
    const after: any = await Therapist.findById(t.body.id).lean();
    expect(after.serviceIds.map(String)).toEqual([String(fx.uci._id)]);
    await request(app).delete(api(`/services/${withSchedule.body.id}`)).set(authed(admin));
  });
  it('el administrador recibe conteos de cuadros y terapeutas', async () => {
    const s = await request(app).get(api('/services')).set(authed(admin));
    const uci = s.body.find((x: any) => x.id === String(fx.uci._id));
    expect(uci).toHaveProperty('scheduleCount'); expect(uci).toHaveProperty('therapistCount');
  });
});

describe('terapeutas', () => {
  beforeEach(async () => { await Therapist.deleteMany({}); await Schedule.deleteMany({}); });

  it('crea, valida duplicados de nombre y documento, y el documento es opcional', async () => {
    const a = await request(app).post(api('/therapists')).set(authed(admin)).send(therapist());
    expect(a.status).toBe(201);
    const dupName = await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ name: 'paula torres', document: '' }));
    expect(dupName.status).toBe(409); expect(dupName.body.message).toBe('Ya existe una terapeuta con ese nombre.');
    const dupDoc = await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ name: 'Otra Persona' }));
    expect(dupDoc.status).toBe(409); expect(dupDoc.body.message).toBe('Ese documento ya está registrado.');
    // dos sin documento no chocan entre sí
    expect((await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ name: 'Sin Doc Uno', document: '' }))).status).toBe(201);
    expect((await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ name: 'Sin Doc Dos', document: '' }))).status).toBe(201);
  });
  it('valida servicios y cargo', async () => {
    expect((await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ serviceIds: [] }))).body.message).toBe('Elige al menos un servicio.');
    expect((await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ serviceIds: [oid()] }))).status).toBe(400);
    expect((await request(app).post(api('/therapists')).set(authed(admin)).send(therapist({ position: 'Médico' }))).status).toBe(400);
  });
  it('filtra por búsqueda (nombre o documento), servicio, tipo y estado', async () => {
    const post = (b: object) => request(app).post(api('/therapists')).set(authed(admin)).send(b);
    await post(therapist({ name: 'Laura Gómez', document: '100', serviceIds: [String(fx.uci._id)] }));
    await post(therapist({ name: 'Diana Muñoz', document: '200', defaultKind: 'apoyo', serviceIds: [String(fx.hos._id)] }));
    await post(therapist({ name: 'Camila Torres', document: '300', active: false, serviceIds: [String(fx.hos._id)] }));
    const get = async (qs: string) => (await request(app).get(api(`/therapists?${qs}`)).set(authed(coord))).body.map((t: any) => t.name);
    expect(await get('')).toEqual(['Camila Torres', 'Diana Muñoz', 'Laura Gómez']);
    expect(await get('q=gomez')).toEqual([]); // la búsqueda no ignora tildes, igual que el mockup
    expect(await get('q=g%C3%B3mez')).toEqual(['Laura Gómez']);
    expect(await get('q=200')).toEqual(['Diana Muñoz']);
    expect(await get(`service=${fx.hos._id}`)).toEqual(['Camila Torres', 'Diana Muñoz']);
    expect(await get('kind=apoyo')).toEqual(['Diana Muñoz']);
    expect(await get('active=false')).toEqual(['Camila Torres']);
    expect(await get('q=.*')).toEqual([]); // el texto se toma literal, no como expresión regular
  });
  it('no elimina a una terapeuta que aparece en un cuadro (409) y cuenta sus cuadros', async () => {
    const t = await request(app).post(api('/therapists')).set(authed(admin)).send(therapist());
    await Schedule.create({ serviceId: fx.uci._id, year: 2026, month: 9, ownerId: fx.admin._id, members: [{ therapistId: t.body.id, kind: 'fija', days: [] }] });
    const list = await request(app).get(api('/therapists')).set(authed(admin));
    expect(list.body[0].scheduleCount).toBe(1);
    const del = await request(app).delete(api(`/therapists/${t.body.id}`)).set(authed(admin));
    expect(del.status).toBe(409); expect(del.body.message).toMatch(/desactívala/);
    const off = await request(app).patch(api(`/therapists/${t.body.id}`)).set(authed(admin)).send(therapist({ active: false }));
    expect(off.body.active).toBe(false);
    await Schedule.deleteMany({});
    expect((await request(app).delete(api(`/therapists/${t.body.id}`)).set(authed(admin))).status).toBe(204);
  });
});

describe('usuarios', () => {
  it('crea activo con servicios, impide correos repetidos y no devuelve el hash', async () => {
    const body = { name: 'Coord Nueva', email: 'nueva.coord@test.co', role: 'coord', serviceIds: [String(fx.hos._id)], password: 'inicial-1234' };
    const c = await request(app).post(api('/users')).set(authed(admin)).send(body);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'activo', role: 'coord' });
    expect(JSON.stringify(c.body)).not.toMatch(/passwordHash|password/);
    expect((await request(app).post(api('/users')).set(authed(admin)).send(body)).status).toBe(409);
    expect((await login('nueva.coord@test.co', 'inicial-1234')).res.status).toBe(200);
  });
  it('una coordinadora debe tener al menos un servicio; el administrador queda sin servicios', async () => {
    const base = { name: 'Sin Servicio', email: 'sin@test.co', password: 'inicial-1234', serviceIds: [] };
    const r = await request(app).post(api('/users')).set(authed(admin)).send({ ...base, role: 'coord' });
    expect(r.status).toBe(400); expect(r.body.message).toBe('Asigna al menos un servicio.');
    const a = await request(app).post(api('/users')).set(authed(admin)).send({ ...base, role: 'admin', serviceIds: [String(fx.uci._id)] });
    expect(a.body.serviceIds).toEqual([]);
  });
  it('aprueba una solicitud pendiente y solo una vez', async () => {
    await request(app).post(api('/auth/register')).send({ name: 'Pendiente Uno', email: 'pend@test.co', password: 'clave-segura-1' });
    const u: any = await User.findOne({ email: 'pend@test.co' });
    const body = { name: 'Pendiente Uno', email: 'pend@test.co', role: 'coord', serviceIds: [String(fx.uci._id)] };
    const ok = await request(app).post(api(`/users/${u._id}/approve`)).set(authed(admin)).send(body);
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('activo');
    expect((await login('pend@test.co')).res.status).toBe(200);
    expect((await request(app).post(api(`/users/${u._id}/approve`)).set(authed(admin)).send(body)).status).toBe(409);
  });
  it('nadie cambia su propio rol ni se elimina a sí mismo; sí puede editar a otro administrador', async () => {
    const edit = { name: 'Admin Prueba', email: 'admin@test.co', role: 'coord', serviceIds: [String(fx.uci._id)] };
    expect((await request(app).patch(api(`/users/${fx.admin._id}`)).set(authed(admin)).send(edit)).status).toBe(403);
    expect((await request(app).delete(api(`/users/${fx.admin._id}`)).set(authed(admin))).status).toBe(403);
    const other = await request(app).post(api('/users')).set(authed(admin)).send({ name: 'Segundo Admin', email: 'admin2@test.co', role: 'admin', serviceIds: [], password: 'inicial-1234' });
    const demote = await request(app).patch(api(`/users/${other.body.id}`)).set(authed(admin))
      .send({ name: 'Segundo Admin', email: 'admin2@test.co', role: 'coord', serviceIds: [String(fx.hos._id)] });
    expect(demote.body).toMatchObject({ role: 'coord', serviceIds: [String(fx.hos._id)] });
    expect((await request(app).delete(api(`/users/${other.body.id}`)).set(authed(admin))).status).toBe(204);
  });
  it('registra auditoría de lo que cambia', async () => {
    const n = await AuditLog.countDocuments({ entity: 'user', action: 'create' });
    expect(n).toBeGreaterThan(0);
  });
});
