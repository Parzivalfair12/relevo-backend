import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closeGenerator } from '../src/lib/generate';
import { Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, shared: any[];
const WORK = ['M', 'T', 'N', 'MT'];

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  const mk = (name: string, serviceIds: unknown[]) => Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds, active: true });
  shared = await Promise.all([mk('Ana Compartida', [fx.uci._id, fx.hos._id]), mk('Bea Compartida', [fx.uci._id, fx.hos._id])]);
  await Promise.all(['Cira UCI', 'Dora UCI', 'Eva UCI'].map(n => mk(n, [fx.uci._id])));
  await Promise.all(['Fran HOS', 'Gaby HOS', 'Hilda HOS', 'Iris HOS', 'Julia HOS'].map(n => mk(n, [fx.hos._id])));
  admin = (await login('admin@test.co')).token;
});
afterAll(async () => { await closeGenerator(); await teardownDb(); });

const create = (serviceId: unknown, month = 3) => request(app).post(api('/schedules')).set(authed(admin)).send({ serviceId: String(serviceId), year: 2029, month });
const get = (id: string) => request(app).get(api(`/schedules/${id}`)).set(authed(admin));
const crossings = (a: any, b: any) => shared.flatMap(t => {
  const id = String(t._id), ra = a.members.find((m: any) => m.therapistId === id)?.days ?? [], rb = b.members.find((m: any) => m.therapistId === id)?.days ?? [];
  return ra.flatMap((c: string, d: number) => (WORK.includes(c) && WORK.includes(rb[d]) ? [`${id}:${d}`] : []));
});
const crossIssues = async (id: string) => (await request(app).get(api(`/schedules/${id}/validation`)).set(authed(admin))).body.issues.filter((i: any) => /también trabaja en/.test(i.msg));

describe('el generador no crea cruces entre servicios', () => {
  let uci: any, hos: any;
  it('un cuadro creado después evita los días en que sus terapeutas ya trabajan en el primero', async () => {
    uci = (await create(fx.uci._id)).body;
    const sharedWork = shared.map(t => uci.members.find((m: any) => m.therapistId === String(t._id)).days.filter((c: string) => WORK.includes(c)).length);
    expect(sharedWork.every((n: number) => n > 5)).toBe(true); // de verdad trabajan en la UCI: el cruce era posible
    hos = (await create(fx.hos._id)).body;
    expect(crossings(uci, hos)).toEqual([]);
    expect(hos.busy).toEqual({});
    expect(await crossIssues(hos.id)).toEqual([]);
    expect(await crossIssues(uci.id)).toEqual([]);
  });
  it('el cuadro informa los días ocupados en otros servicios (occupied), que son los turnos del otro cuadro', async () => {
    const t = String(shared[0]._id), uciDays = uci.members.find((m: any) => m.therapistId === t).days;
    expect(hos.occupied[t]).toEqual(uciDays.flatMap((c: string, d: number) => (WORK.includes(c) ? [d] : [])));
    expect(hos.occupied[String(shared[1]._id)].length).toBeGreaterThan(0);
    expect(Object.keys(hos.occupied).sort()).toEqual(shared.map(x => String(x._id)).sort()); // solo las que están en ambos
    expect(uci.occupied).toEqual({});                                                          // el primero se hizo cuando el otro aún no existía
  });
  it('al volver a generar uno de los dos (otra variante, cobertura o reglas) tampoco aparecen', async () => {
    let cur = (await get(uci.id)).body;
    for (const variant of [true, false, true]) {
      const r = await request(app).post(api(`/schedules/${cur.id}/generate`)).set(authed(admin)).send({ version: cur.version, variant });
      expect(r.status).toBe(200); cur = r.body;
      expect(crossings(cur, (await get(hos.id)).body)).toEqual([]);
    }
    const cov = await request(app).patch(api(`/schedules/${cur.id}`)).set(authed(admin)).send({ version: cur.version, rules: { ...cur.rules, maxConsec: 4 } });
    expect(cov.status).toBe(200);
    expect(crossings(cov.body, (await get(hos.id)).body)).toEqual([]);
    expect(await crossIssues(hos.id)).toEqual([]);
  });
  it('lo fijado a mano se respeta aunque cruce, y se avisa como antes', async () => {
    let cur = (await get(hos.id)).body;
    const t = String(shared[0]._id), taken = (await get(uci.id)).body.members.find((m: any) => m.therapistId === t).days.findIndex((c: string) => WORK.includes(c));
    const r = await request(app).put(api(`/schedules/${cur.id}/cells`)).set(authed(admin)).send({ version: cur.version, changes: [{ therapistId: t, day: taken, code: 'M' }] });
    expect(r.status).toBe(200); cur = r.body;
    expect(cur.members.find((m: any) => m.therapistId === t).days[taken]).toBe('M');
    expect(cur.busy[t][taken]).toBe('UCI Neurocrítica');
    expect((await crossIssues(hos.id)).length).toBe(1);
    // al regenerar, esa casilla fijada se mantiene y no aparecen más cruces
    const again = await request(app).post(api(`/schedules/${cur.id}/generate`)).set(authed(admin)).send({ version: cur.version, variant: true });
    expect(again.body.members.find((m: any) => m.therapistId === t).days[taken]).toBe('M');
    expect(await crossIssues(hos.id)).toHaveLength(1);
  });
  it('si no alcanzan las personas se ve un hueco de cobertura en vez de un cruce', async () => {
    // un tercer servicio con solo dos personas, las dos ya ocupadas en la UCI y en Hospitalización la mitad del mes
    const lone = await request(app).post(api('/services')).set(authed(admin)).send({ name: 'Servicio Corto', color: '#6BC48F' });
    for (const t of shared) await Therapist.updateOne({ _id: t._id }, { $addToSet: { serviceIds: lone.body.id } });
    const s = await request(app).post(api('/schedules')).set(authed(admin)).send({ serviceId: lone.body.id, year: 2029, month: 3 });
    expect(s.status).toBe(201);
    expect(s.body.members).toHaveLength(2);
    const c = s.body.members.map((m: any) => m.days);
    expect(c.every((row: string[], i: number) => row.every((x, d) => !WORK.includes(x) || !(s.body.occupied[s.body.members[i].therapistId] ?? []).includes(d)))).toBe(true);
    expect(await crossIssues(s.body.id)).toEqual([]);
    expect((await request(app).get(api(`/schedules/${s.body.id}/validation`)).set(authed(admin))).body.gapDays).toBeGreaterThan(0);
  });
});
