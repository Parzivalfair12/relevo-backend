import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closeGenerator } from '../src/lib/generate';
import { hashPassword } from '../src/lib/tokens';
import { AuditLog, Schedule, Therapist, User } from '../src/models/index';
import { PW, app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string, team: any[];

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  team = await Promise.all(['Ana Uno', 'Bea Dos', 'Cira Tres'].map(name =>
    Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [fx.uci._id, fx.hos._id], active: true })));
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(async () => { await closeGenerator(); await teardownDb(); });

const create = (token: string, serviceId: unknown, month: number) =>
  request(app).post(api('/schedules')).set(authed(token)).send({ serviceId: String(serviceId), year: 2030, month });
const patch = (token: string, id: string, body: object) => request(app).patch(api(`/schedules/${id}`)).set(authed(token)).send(body);
const put = (token: string, id: string, body: object) => request(app).put(api(`/schedules/${id}/cells`)).set(authed(token)).send(body);
const del = (token: string, path: string) => request(app).delete(api(path)).set(authed(token));
const get = (token: string, id: string) => request(app).get(api(`/schedules/${id}`)).set(authed(token));

describe('un cuadro publicado no se edita', () => {
  let s: any;
  beforeAll(async () => { s = (await create(coord, fx.uci._id, 0)).body; s = (await patch(coord, s.id, { version: s.version, status: 'pub' })).body; });

  it('responde 409 PUBLISHED_LOCKED al pintar, generar, tocar ausencias, cobertura, reglas o equipo', async () => {
    const t = String(team[0]._id);
    const cases: [string, request.Test][] = [
      ['casillas', put(coord, s.id, { version: s.version, changes: [{ therapistId: t, day: 0, code: 'M' }] })],
      ['generar', request(app).post(api(`/schedules/${s.id}/generate`)).set(authed(coord)).send({ version: s.version, variant: true })],
      ['ausencia', request(app).post(api(`/schedules/${s.id}/absences`)).set(authed(coord)).send({ version: s.version, therapistId: t, code: 'V', from: 2, to: 4 })],
      ['quitar ausencia', request(app).delete(api(`/schedules/${s.id}/absences?version=${s.version}&therapistId=${t}&from=2&to=4`)).set(authed(coord))],
      ['cobertura', patch(coord, s.id, { version: s.version, coverage: { M: 2, T: 1, N: 1 } })],
      ['reglas', patch(coord, s.id, { version: s.version, rules: { ...s.rules, maxConsec: 4 } })],
      ['equipo', patch(coord, s.id, { version: s.version, team: s.members.slice(0, 2).map((m: any) => ({ therapistId: m.therapistId, kind: m.kind })) })]
    ];
    for (const [what, req] of cases) {
      const r = await req;
      expect([what, r.status, r.body.code]).toEqual([what, 409, 'PUBLISHED_LOCKED']);
      expect(r.body.message).toBe('Este cuadro está publicado. Vuelve a borrador para editarlo.');
    }
    const after = (await get(coord, s.id)).body;
    expect(after.version).toBe(s.version); expect(after.members).toEqual(s.members); // no cambió nada
  });
  it('si la versión está vieja avisa del conflicto antes que del bloqueo', async () => {
    const r = await put(coord, s.id, { version: s.version - 1 >= 0 ? s.version - 1 : 99, changes: [{ therapistId: String(team[0]._id), day: 0, code: 'M' }] });
    expect(r.status).toBe(409); expect(r.body.code).toBe('VERSION_CONFLICT');
  });
  it('volver a borrador sí se puede, y también hacerlo junto con un cambio; con borrador se edita de nuevo', async () => {
    const back = await patch(coord, s.id, { version: s.version, status: 'bor' });
    expect(back.status).toBe(200); expect(back.body.status).toBe('bor');
    const painted = await put(coord, s.id, { version: back.body.version, changes: [{ therapistId: String(team[0]._id), day: 0, code: 'M' }] });
    expect(painted.status).toBe(200);
    const pub = await patch(coord, s.id, { version: painted.body.version, status: 'pub' });
    const both = await patch(coord, s.id, { version: pub.body.version, status: 'bor', coverage: { M: 2, T: 1, N: 1 } });
    expect(both.status).toBe(200); expect(both.body.coverage.M).toBe(2); expect(both.body.status).toBe('bor');
  });
});

describe('eliminar un cuadro', () => {
  it('solo en borrador; lo borra, deja registro y deja de existir', async () => {
    const c = (await create(coord, fx.uci._id, 1)).body;
    const r = await del(coord, `/schedules/${c.id}`);
    expect(r.status).toBe(204);
    expect((await get(coord, c.id)).status).toBe(404);
    expect(await Schedule.countDocuments({ _id: c.id })).toBe(0);
    expect(await AuditLog.countDocuments({ summary: /Eliminó el cuadro de UCI Neurocrítica 2\/2030 \(borrador\)/ })).toBe(1);
    // el mes queda libre para crearlo de nuevo
    expect((await create(coord, fx.uci._id, 1)).status).toBe(201);
  });
  it('uno publicado responde 409 y sigue existiendo; tras volver a borrador sí se elimina', async () => {
    let c = (await create(coord, fx.uci._id, 2)).body;
    c = (await patch(coord, c.id, { version: c.version, status: 'pub' })).body;
    const no = await del(coord, `/schedules/${c.id}`);
    expect(no.status).toBe(409); expect(no.body.code).toBe('PUBLISHED_LOCKED');
    expect(no.body.message).toBe('Un cuadro publicado no se puede eliminar. Vuelve a borrador primero.');
    expect(await Schedule.countDocuments({ _id: c.id })).toBe(1);
    const back = (await patch(coord, c.id, { version: c.version, status: 'bor' })).body;
    expect(back.status).toBe('bor');
    expect((await del(coord, `/schedules/${c.id}`)).status).toBe(204);
  });
  it('respeta el alcance: la coordinadora no elimina cuadros de otro servicio; sin sesión 401; inexistente 404', async () => {
    const other = (await create(admin, fx.hos._id, 3)).body;
    expect((await del(coord, `/schedules/${other.id}`)).status).toBe(403);
    expect(await Schedule.countDocuments({ _id: other.id })).toBe(1);
    expect((await request(app).delete(api(`/schedules/${other.id}`))).status).toBe(401);
    expect((await del(admin, '/schedules/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await del(admin, `/schedules/${other.id}`)).status).toBe(204); // el administrador sí
  });
});

describe('eliminar a una persona que es dueña de cuadros', () => {
  const mk = async (email: string, status: 'activo' | 'pendiente' = 'activo') =>
    User.create({ name: `Persona ${email}`, email, role: 'coord', status, serviceIds: [fx.uci._id], passwordHash: await hashPassword(PW) });

  it('sin cuadros se elimina como siempre', async () => {
    const u: any = await mk('libre@test.co');
    expect((await del(admin, `/users/${u._id}`)).status).toBe(204);
    expect(await User.countDocuments({ _id: u._id })).toBe(0);
  });
  it('con cuadros responde 409 con cuántos y no la elimina', async () => {
    const owner: any = await mk('duena@test.co');
    const tok = (await login('duena@test.co')).token;
    expect((await create(tok, fx.uci._id, 4)).status).toBe(201); expect((await create(tok, fx.uci._id, 5)).status).toBe(201);
    const r = await del(admin, `/users/${owner._id}`);
    expect(r.status).toBe(409); expect(r.body.code).toBe('OWNS_SCHEDULES'); expect(r.body.details).toEqual({ count: 2 });
    expect(r.body.message).toMatch(/dueña de 2 cuadro\(s\)/);
    expect(await User.countDocuments({ _id: owner._id })).toBe(1);
  });
  it('con reassignTo pasa los cuadros a la otra persona y la elimina', async () => {
    const owner: any = await User.findOne({ email: 'duena@test.co' }), heir: any = await mk('heredera@test.co');
    const r = await del(admin, `/users/${owner._id}?reassignTo=${heir._id}`);
    expect(r.status).toBe(204);
    const mine = [...(await Schedule.find({ year: 2030, month: 4 }).lean()), ...(await Schedule.find({ year: 2030, month: 5 }).lean())];
    expect(mine).toHaveLength(2); expect(mine.every((m: any) => String(m.ownerId) === String(heir._id))).toBe(true);
    const list = await request(app).get(api('/schedules')).set(authed(admin));
    expect(list.body.filter((c: any) => c.ownerId === String(heir._id)).every((c: any) => c.ownerName === 'Persona heredera@test.co')).toBe(true);
    expect(await AuditLog.countDocuments({ summary: /Eliminó el usuario duena@test.co y pasó 2 cuadro\(s\) a otra persona/ })).toBe(1);
  });
  it('no acepta pasárselos a sí misma, a alguien inexistente ni pendiente; y no cambia nada si falla', async () => {
    const owner: any = await mk('otra.duena@test.co'), pend: any = await mk('pendiente@test.co', 'pendiente');
    const tok = (await login('otra.duena@test.co')).token;
    await create(tok, fx.uci._id, 6);
    for (const to of [String(owner._id), 'aaaaaaaaaaaaaaaaaaaaaaaa', String(pend._id)]) {
      expect([to, (await del(admin, `/users/${owner._id}?reassignTo=${to}`)).status]).toEqual([to, 400]);
    }
    expect((await del(admin, `/users/${owner._id}?reassignTo=no-es-un-id`)).status).toBe(400);
    expect(await User.countDocuments({ _id: owner._id })).toBe(1);
    expect(await Schedule.countDocuments({ ownerId: owner._id })).toBe(1);
  });
  it('sigue siendo solo para administradores', async () => {
    const u: any = await mk('objeto@test.co');
    expect((await del(coord, `/users/${u._id}`)).status).toBe(403);
  });
});
