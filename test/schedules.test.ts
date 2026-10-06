import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closeGenerator } from '../src/lib/generate';
import { AuditLog, Schedule, Service, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, oid, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string;
let uciTeam: any[], hosTeam: any[], shared: any;

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  const mk = (name: string, kind: 'fija' | 'apoyo', serviceIds: unknown[], active = true) =>
    Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: kind, serviceIds, active });
  shared = await mk('Compartida Díaz', 'fija', [fx.uci._id, fx.hos._id]);
  uciTeam = [shared, await mk('Ana Uno', 'fija', [fx.uci._id]), await mk('Bea Dos', 'fija', [fx.uci._id]), await mk('Cira Tres', 'fija', [fx.uci._id]), await mk('Dora Apoyo', 'apoyo', [fx.uci._id])];
  await mk('Inactiva Vieja', 'fija', [fx.uci._id], false);
  hosTeam = [shared, await mk('Eva Hos', 'fija', [fx.hos._id])];
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(async () => { await closeGenerator(); await teardownDb(); });

const create = (token: string, serviceId: unknown, year = 2026, month = 9) =>
  request(app).post(api('/schedules')).set(authed(token)).send({ serviceId: String(serviceId), year, month });
const put = (token: string, id: string, body: object) => request(app).put(api(`/schedules/${id}/cells`)).set(authed(token)).send(body);
const patch = (token: string, id: string, body: object) => request(app).patch(api(`/schedules/${id}`)).set(authed(token)).send(body);
const get = (token: string, id: string) => request(app).get(api(`/schedules/${id}`)).set(authed(token));
const member = (dto: any, therapistId: unknown) => dto.members.find((m: any) => m.therapistId === String(therapistId));

describe('crear cuadros', () => {
  let oct: any;
  it('crea con el equipo activo del servicio, genera los 31 días y queda en borrador', async () => {
    const r = await create(coord, fx.uci._id);
    expect(r.status).toBe(201);
    oct = r.body;
    expect(oct).toMatchObject({ status: 'bor', year: 2026, month: 9, ownerName: 'Coord Prueba', version: 0 });
    expect(oct.members.map((m: any) => m.name).sort()).toEqual(['Ana Uno', 'Bea Dos', 'Cira Tres', 'Compartida Díaz', 'Dora Apoyo']); // sin la inactiva
    expect(oct.members.every((m: any) => m.days.length === 31 && m.days.every((c: string) => c !== ''))).toBe(true);
    expect(member(oct, uciTeam[4]._id).kind).toBe('apoyo');
    expect(oct.coverage).toEqual({ M: 1, T: 1, N: 1 });
  });
  it('no repite servicio y mes (409) y exige al menos 2 terapeutas activas (400)', async () => {
    expect((await create(coord, fx.uci._id)).status).toBe(409);
    const solo = await Service.create({ name: 'Servicio de una sola terapeuta', color: '#6BC48F' });
    await Therapist.create({ name: 'Unica Persona', position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [solo._id], active: true });
    const few = await create(admin, solo._id);
    expect(few.status).toBe(400); expect(few.body.message).toMatch(/al menos 2 terapeutas activas/);
  });
  it('el mes siguiente copia el equipo, la cobertura y continúa la secuencia (sin trabajar tras una noche)', async () => {
    const nov = await create(coord, fx.uci._id, 2026, 10);
    expect(nov.status).toBe(201);
    expect(nov.body.members.map((m: any) => m.therapistId).sort()).toEqual(uciTeam.map(t => String(t._id)).sort());
    expect(Object.keys(nov.body.prev).length).toBe(5);
    const v = await request(app).get(api(`/schedules/${nov.body.id}/validation`)).set(authed(coord));
    expect(v.body.issues.filter((i: any) => /mes anterior/.test(i.msg))).toEqual([]);
  });
  it('si una terapeuta del mes anterior ya está inactiva, no pasa al cuadro nuevo', async () => {
    await Therapist.updateOne({ _id: uciTeam[3]._id }, { active: false });
    const dec = await create(coord, fx.uci._id, 2026, 11);
    expect(dec.body.members).toHaveLength(4);
    expect(member(dec.body, uciTeam[3]._id)).toBeUndefined();
    await Therapist.updateOne({ _id: uciTeam[3]._id }, { active: true });
  });
});

describe('permisos por servicio', () => {
  it('la coordinadora no crea ni abre cuadros de servicios que no tiene (403)', async () => {
    expect((await create(coord, fx.hos._id, 2027, 0)).status).toBe(403);
    await Therapist.create({ name: 'Fran Hos', position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [fx.hos._id], active: true });
    const other = await create(admin, fx.hos._id, 2027, 0);
    expect(other.status).toBe(201);
    expect((await get(coord, other.body.id)).status).toBe(403);
    expect((await put(coord, other.body.id, { version: 0, changes: [{ therapistId: hosTeam[1]._id, day: 0, code: 'M' }] })).status).toBe(403);
    expect((await patch(coord, other.body.id, { version: 0, status: 'pub' })).status).toBe(403);
  });
  it('la lista solo trae los cuadros visibles y respeta los filtros', async () => {
    const mine = await request(app).get(api('/schedules')).set(authed(coord));
    expect(mine.status).toBe(200);
    expect(mine.body.every((c: any) => c.serviceId === String(fx.uci._id))).toBe(true);
    const all = await request(app).get(api('/schedules')).set(authed(admin));
    expect(all.body.length).toBeGreaterThan(mine.body.length);
    expect(all.body[0]).toMatchObject({ days: expect.any(Number), totalHours: expect.any(Number), neededHours: expect.any(Number), criticalAlerts: expect.any(Number) });
    expect((await request(app).get(api(`/schedules?service=${fx.hos._id}`)).set(authed(coord))).status).toBe(403);
    const pub = await request(app).get(api('/schedules?status=pub')).set(authed(admin));
    expect(pub.body).toEqual([]);
  });
  it('sin sesión 401 y id mal formado 404', async () => {
    expect((await request(app).get(api('/schedules'))).status).toBe(401);
    expect((await get(admin, 'no-es-un-id')).status).toBe(404);
    expect((await get(admin, oid())).status).toBe(404);
  });
});

describe('edición con control de versiones', () => {
  let s: any;
  beforeAll(async () => { s = (await create(coord, fx.uci._id, 2027, 1)).body; });

  it('pintar fija la casilla y sube la versión', async () => {
    const t = uciTeam[1]._id;
    const r = await put(coord, s.id, { version: s.version, changes: [{ therapistId: t, day: 3, code: 'N' }, { therapistId: t, day: 4, code: 'L' }] });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(s.version + 1);
    expect(member(r.body, t).days.slice(3, 5)).toEqual(['N', 'L']);
    expect(member(r.body, t).locked).toMatchObject({ 3: 'N', 4: 'L' });
    s = r.body;
  });
  it('una versión vieja responde 409 con quién hizo el cambio', async () => {
    const stale = await put(admin, s.id, { version: s.version - 1, changes: [{ therapistId: uciTeam[1]._id, day: 0, code: 'M' }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.details).toMatchObject({ updatedByName: 'Coord Prueba', version: s.version });
    expect(stale.body.message).toMatch(/Coord Prueba/);
    expect((await patch(admin, s.id, { version: s.version - 1, status: 'pub' })).status).toBe(409);
    expect((await get(admin, s.id)).body.version).toBe(s.version); // no se guardó nada
  });
  it('dos escrituras simultáneas con la misma versión: solo una se guarda', async () => {
    const t = uciTeam[3]._id;
    const [a, b] = await Promise.all([
      put(coord, s.id, { version: s.version, changes: [{ therapistId: t, day: 10, code: 'M' }] }),
      put(admin, s.id, { version: s.version, changes: [{ therapistId: t, day: 11, code: 'M' }] })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    s = (await get(admin, s.id)).body;
    expect(s.version).toBeGreaterThan(0);
  });
  it('soltar una casilla fijada quita la fijación y recalcula', async () => {
    const t = uciTeam[1]._id;
    const r = await put(coord, s.id, { version: s.version, changes: [{ therapistId: t, day: 3, code: null }] });
    expect(member(r.body, t).locked[3]).toBeUndefined();
    expect(member(r.body, t).locked[4]).toBe('L'); // la otra sigue fijada
    expect(member(r.body, t).days[4]).toBe('L');
    s = r.body;
  });
  it('valida terapeuta, día y cuerpo', async () => {
    expect((await put(coord, s.id, { version: s.version, changes: [{ therapistId: oid(), day: 0, code: 'M' }] })).status).toBe(400);
    expect((await put(coord, s.id, { version: s.version, changes: [{ therapistId: uciTeam[1]._id, day: 28, code: 'M' }] })).status).toBe(400); // febrero 2027 tiene 28 días
    expect((await put(coord, s.id, { version: s.version, changes: [{ therapistId: uciTeam[1]._id, day: 0, code: 'X' }] })).status).toBe(400);
    expect((await put(coord, s.id, { changes: [] })).status).toBe(400);
  });
  it('ausencias por rango: quedan fijadas, se recalcula y se pueden quitar', async () => {
    const t = uciTeam[2]._id;
    const add = await request(app).post(api(`/schedules/${s.id}/absences`)).set(authed(coord)).send({ version: s.version, therapistId: String(t), code: 'V', from: 5, to: 9 });
    expect(add.status).toBe(200);
    expect(member(add.body, t).days.slice(4, 9)).toEqual(['V', 'V', 'V', 'V', 'V']);
    expect(Object.keys(member(add.body, t).locked).length).toBeGreaterThanOrEqual(5);
    // nadie de planta ausente cubre turnos esos días, pero el cuadro sigue cubierto con el resto
    const bad = await request(app).post(api(`/schedules/${s.id}/absences`)).set(authed(coord)).send({ version: add.body.version, therapistId: String(t), code: 'V', from: 9, to: 5 });
    expect(bad.status).toBe(400);
    const tooLate = await request(app).post(api(`/schedules/${s.id}/absences`)).set(authed(coord)).send({ version: add.body.version, therapistId: String(t), code: 'I', from: 27, to: 31 });
    expect(tooLate.status).toBe(400); expect(tooLate.body.message).toMatch(/28 días/);
    const del = await request(app).delete(api(`/schedules/${s.id}/absences?version=${add.body.version}&therapistId=${t}&from=5&to=9`)).set(authed(coord));
    expect(del.status).toBe(200);
    expect(Object.keys(member(del.body, t).locked)).toEqual([]);
    expect(member(del.body, t).days.slice(4, 9).some((c: string) => c === 'V')).toBe(false);
    s = del.body;
  });
  it('«Otra variante» cambia la semilla y deja la misma cobertura; «generar» la conserva', async () => {
    const v = await request(app).post(api(`/schedules/${s.id}/generate`)).set(authed(coord)).send({ version: s.version, variant: true });
    expect(v.body.seed).toBe((s.seed * 7 + 11) % 9973 + 1);
    const g = await request(app).post(api(`/schedules/${s.id}/generate`)).set(authed(coord)).send({ version: v.body.version });
    expect(g.body.seed).toBe(v.body.seed);
    expect(g.body.members.map((m: any) => m.days)).toEqual(v.body.members.map((m: any) => m.days)); // determinista con la misma semilla
    s = g.body;
  });
  it('publicar y volver a borrador no tocan los turnos', async () => {
    const p = await patch(coord, s.id, { version: s.version, status: 'pub' });
    expect(p.body.status).toBe('pub');
    expect(p.body.members.map((m: any) => m.days)).toEqual(s.members.map((m: any) => m.days));
    const b = await patch(coord, s.id, { version: p.body.version, status: 'bor' });
    expect(b.body.status).toBe('bor'); s = b.body;
  });
  it('reglas y cobertura recalculan; el equipo se puede cambiar (mínimo 2, solo activas)', async () => {
    const eq = await patch(coord, s.id, { version: s.version, rules: { ...s.rules, support: 'equal' } });
    expect(eq.body.rules.support).toBe('equal');
    const cov = await patch(coord, s.id, { version: eq.body.version, coverage: { M: 2, T: 1, N: 1 } });
    expect(cov.body.coverage.M).toBe(2); s = cov.body;
    const team = s.members.map((m: any) => ({ therapistId: m.therapistId, kind: m.kind }));
    const short = await patch(coord, s.id, { version: s.version, team: team.slice(0, 1) });
    expect(short.status).toBe(400);
    const inactive = await Therapist.findOne({ name: 'Inactiva Vieja' });
    expect((await patch(coord, s.id, { version: s.version, team: [...team, { therapistId: String(inactive!._id), kind: 'apoyo' }] })).status).toBe(400);
    const smaller = await patch(coord, s.id, { version: s.version, team: team.filter((t: any) => t.therapistId !== String(uciTeam[4]._id)) });
    expect(smaller.body.members).toHaveLength(4);
    const kind = await patch(coord, s.id, { version: smaller.body.version, team: smaller.body.members.map((m: any) => ({ therapistId: m.therapistId, kind: m.therapistId === String(uciTeam[3]._id) ? 'apoyo' : m.kind })) });
    expect(member(kind.body, uciTeam[3]._id).kind).toBe('apoyo');
    expect(kind.body.members.every((m: any) => m.days.length === 28)).toBe(true);
  });
  it('la lista cuenta alertas críticas y registra la auditoría', async () => {
    const list = await request(app).get(api('/schedules')).set(authed(coord));
    const card = list.body.find((c: any) => c.id === s.id);
    expect(card.planta + card.apoyo).toBe(4);
    expect(await AuditLog.countDocuments({ entity: 'schedule' })).toBeGreaterThan(3);
  });
});

describe('cruces entre servicios', () => {
  it('una terapeuta que trabaja el mismo día en dos cuadros genera error y aparece en `busy`', async () => {
    await Schedule.deleteMany({});
    await Therapist.create({ name: 'Gina Hos', position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [fx.hos._id], active: true });
    const uci = (await create(admin, fx.uci._id, 2026, 9)).body, hos = (await create(admin, fx.hos._id, 2026, 9)).body;
    const t = String(shared._id);
    // Se fuerza el choque: el día 1 trabaja en los dos servicios
    const a = await put(admin, uci.id, { version: uci.version, changes: [{ therapistId: t, day: 0, code: 'M' }] });
    const b = await put(admin, hos.id, { version: hos.version, changes: [{ therapistId: t, day: 0, code: 'T' }] });
    expect(b.body.busy[t][0]).toBe('UCI Neurocrítica');
    const v = await request(app).get(api(`/schedules/${hos.id}/validation`)).set(authed(admin));
    expect(v.body.issues.map((i: any) => i.msg)).toContain('Compartida Díaz: el día 1 también trabaja en UCI Neurocrítica');
    expect(v.body.errors).toBeGreaterThan(0);
    // ...y se ve en la tarjeta de los dos
    const list = await request(app).get(api('/schedules')).set(authed(admin));
    expect(list.body.find((c: any) => c.id === uci.id).criticalAlerts).toBeGreaterThan(0);
    // Soltar el cruce lo resuelve en esa casilla
    const fix = await put(admin, hos.id, { version: b.body.version, changes: [{ therapistId: t, day: 0, code: 'L' }] });
    expect(fix.body.busy[t]?.[0]).toBeUndefined();
    expect(a.status).toBe(200);
  });
});
