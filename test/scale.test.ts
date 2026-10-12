import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Schedule, Service, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string, people: any[];
const get = (token: string, path: string) => request(app).get(api(path)).set(authed(token));
const rules = { seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' };
const daysOf = (n: number, over: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => over[i] ?? 'L');
const dim = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** Cuadro de dos personas con turnos dados (índice 0 = día 1) */
const sched = (serviceId: unknown, year: number, month: number, a: Record<number, string>, b: Record<number, string> = {}, status = 'bor') => Schedule.create({
  serviceId, year, month, status, ownerId: fx.admin._id, coverage: { M: 1, T: 1, N: 1 }, rules,
  members: [
    { therapistId: people[0]._id, kind: 'fija', days: daysOf(dim(year, month), a), locked: [] },
    { therapistId: people[1]._id, kind: 'fija', days: daysOf(dim(year, month), b), locked: [] }
  ]
});

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  // 30 terapeutas: 1 de cada 5 inactiva, algunas de apoyo; los nombres salen en desorden para comprobar el orden alfabético
  const names = Array.from({ length: 30 }, (_, i) => `Persona ${String.fromCharCode(65 + ((i * 7) % 26))}${String(i).padStart(2, '0')}`);
  people = [];
  for (const [i, name] of names.entries()) people.push(await Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: i % 3 === 0 ? 'apoyo' : 'fija', serviceIds: [i % 2 ? fx.hos._id : fx.uci._id], active: i % 5 !== 4 }));
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(teardownDb);

describe('directorio por páginas', () => {
  it('recorre todo sin repetir, en orden alfabético, con el total y el conteo de cuadros', async () => {
    await sched(fx.uci._id, 2031, 0, { 0: 'M' }); // personas 0 y 1 aparecen en un cuadro
    const full = (await get(coord, '/therapists')).body;
    const seen: any[] = []; let page = 1, total = 0;
    for (;;) {
      const r = await get(coord, `/therapists/page?page=${page}&limit=12`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ page, pageSize: 12 }); total = r.body.total;
      seen.push(...r.body.items);
      if (r.body.items.length < 12) break;
      page++;
    }
    expect(total).toBe(30); expect(page).toBe(3); // 12 + 12 + 6
    expect(seen.map(t => t.id)).toEqual(full.map((t: any) => t.id)); // el mismo orden que la lista completa
    expect(new Set(seen.map(t => t.id)).size).toBe(30);
    expect(seen.map(t => t.name)).toEqual([...seen.map(t => t.name)].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' })));
    expect(seen.find(t => t.id === String(people[0]._id)).scheduleCount).toBe(1);
    expect(seen.find(t => t.id === String(people[2]._id)).scheduleCount).toBe(0);
  });
  it('aplica los mismos filtros que la lista completa y cuenta el total filtrado', async () => {
    const filtered = async (qs: string) => { const r = await get(coord, `/therapists/page?${qs}&limit=100`); return { total: r.body.total, n: r.body.items.length }; };
    for (const qs of ['active=true', 'active=false', 'kind=apoyo', `service=${fx.hos._id}`, 'q=Persona%20A', 'active=true&kind=fija']) {
      const full = (await get(coord, `/therapists?${qs}`)).body;
      expect(await filtered(qs)).toEqual({ total: full.length, n: full.length });
    }
    expect((await get(coord, '/therapists/page?active=true&limit=5&page=2')).body.items).toHaveLength(5);
    expect((await get(coord, '/therapists/page?page=99')).body).toMatchObject({ items: [], total: 30 }); // más allá de la última: vacío
  });
  it('rechaza páginas y tamaños inválidos y exige sesión', async () => {
    for (const qs of ['page=0', 'limit=0', 'limit=101', 'page=x', 'kind=otro']) expect([qs, (await get(coord, `/therapists/page?${qs}`)).status]).toEqual([qs, 400]);
    expect((await request(app).get(api('/therapists/page'))).status).toBe(401);
    expect((await get(coord, '/therapists')).body).toBeInstanceOf(Array); // la lista completa sigue igual
  });
});

describe('cuadros por ventana de meses', () => {
  beforeAll(async () => {
    await Schedule.deleteMany({});
    // 12 meses de 2032 en la UCI y en Hospitalización. Junio: la persona 0 trabaja el día 10 en los dos servicios (cruce).
    // Junio termina con noche y julio empieza trabajando en la UCI (falla la continuidad).
    for (let m = 0; m < 12; m++) {
      const uci: Record<number, string> = m === 5 ? { 9: 'M', 29: 'N' } : m === 6 ? { 0: 'M' } : { 3: 'M' };
      await sched(fx.uci._id, 2032, m, uci, {}, m < 6 ? 'pub' : 'bor');
      await sched(fx.hos._id, 2032, m, m === 5 ? { 9: 'T' } : {}, {});
    }
  });
  it('trae solo los meses pedidos, con las mismas alertas que cuando se piden todos', async () => {
    const full = (await get(admin, '/schedules')).body, win = await get(admin, '/schedules?from=2032-06&to=2032-08');
    expect(full).toHaveLength(24);
    expect(win.status).toBe(200); expect(win.body).toHaveLength(6);
    expect(new Set(win.body.map((c: any) => c.month))).toEqual(new Set([5, 6, 7]));
    for (const c of win.body) expect(c).toEqual(full.find((f: any) => f.id === c.id)); // idénticas: cruces y continuidad incluidos
    const june = win.body.filter((c: any) => c.month === 5), july = win.body.find((c: any) => c.month === 6 && c.serviceId === String(fx.uci._id));
    expect(june.every((c: any) => c.criticalAlerts > 0)).toBe(true); // el cruce del 10 de junio
    expect(july.criticalAlerts).toBeGreaterThan(0);                  // noche del 30 de junio → trabaja el 1 de julio
  });
  it('un solo mes necesita el anterior para la continuidad, aunque no se vea', async () => {
    const full = (await get(admin, '/schedules')).body, one = (await get(admin, '/schedules?from=2032-07&to=2032-07')).body;
    expect(one).toHaveLength(2);
    for (const c of one) expect(c).toEqual(full.find((f: any) => f.id === c.id));
    expect(one.find((c: any) => c.serviceId === String(fx.uci._id)).criticalAlerts).toBeGreaterThan(0);
  });
  it('acepta solo desde o solo hasta, mezcla con servicio y estado, y respeta el alcance', async () => {
    expect((await get(admin, '/schedules?from=2032-11')).body).toHaveLength(4);        // nov y dic de los dos servicios
    expect((await get(admin, '/schedules?to=2032-02')).body).toHaveLength(4);          // enero y febrero
    expect((await get(admin, `/schedules?from=2032-01&to=2032-12&status=pub&service=${fx.uci._id}`)).body).toHaveLength(6);
    const mine = (await get(coord, '/schedules?from=2032-01&to=2032-12')).body;       // la coordinadora solo tiene la UCI
    expect(mine).toHaveLength(12); expect(mine.every((c: any) => c.serviceId === String(fx.uci._id))).toBe(true);
    expect((await get(coord, `/schedules?from=2032-01&service=${fx.hos._id}`)).status).toBe(403);
  });
  it('rechaza meses mal escritos o invertidos', async () => {
    for (const qs of ['from=2032-13', 'to=2032-1', 'from=2032-08&to=2032-03', 'from=junio']) expect([qs, (await get(admin, `/schedules?${qs}`)).status]).toEqual([qs, 400]);
  });
});

describe('índice liviano y versión del cuadro', () => {
  it('el índice trae servicio, mes y estado de todos los cuadros visibles, sin turnos', async () => {
    const r = await get(admin, '/schedules/index');
    expect(r.status).toBe(200); expect(r.body).toHaveLength(24);
    expect(Object.keys(r.body[0]).sort()).toEqual(['month', 'serviceId', 'status', 'year']);
    const mine = (await get(coord, '/schedules/index')).body;
    expect(mine).toHaveLength(12); expect(mine.every((c: any) => c.serviceId === String(fx.uci._id))).toBe(true);
    expect((await request(app).get(api('/schedules/index'))).status).toBe(401);
  });
  it('la versión sube con cada cambio y dice quién lo hizo; respeta el alcance', async () => {
    const list = (await get(admin, '/schedules')).body, uci = list.find((c: any) => c.serviceId === String(fx.uci._id)), hos = list.find((c: any) => c.serviceId === String(fx.hos._id));
    const v0 = await get(coord, `/schedules/${uci.id}/version`);
    expect(v0.status).toBe(200); expect(v0.body.version).toBe(0);
    const edit = await request(app).put(api(`/schedules/${uci.id}/cells`)).set(authed(coord)).send({ version: 0, changes: [{ therapistId: String(people[0]._id), day: 15, code: 'M' }] });
    expect(edit.status).toBe(200);
    expect((await get(admin, `/schedules/${uci.id}/version`)).body).toEqual({ version: 1, updatedByName: 'Coord Prueba' });
    expect((await get(coord, `/schedules/${hos.id}/version`)).status).toBe(403);
    expect((await get(admin, '/schedules/aaaaaaaaaaaaaaaaaaaaaaaa/version')).status).toBe(404);
    expect((await request(app).get(api(`/schedules/${uci.id}/version`))).status).toBe(401);
  });
});

describe('el resumen no depende de lo que haya fuera del período', () => {
  it('con años de histórico da lo mismo, y los tres últimos meses del gráfico son los más recientes', async () => {
    await Schedule.deleteMany({});
    const svc = await Service.create({ name: 'Servicio Histórico', color: '#6BC48F' });
    await sched(fx.uci._id, 2033, 1, { 0: 'M', 1: 'M' });   // febrero 2033: 12 h
    await sched(fx.uci._id, 2033, 2, { 0: 'N' });            // marzo 2033: 12 h
    const q = '/dashboard?from=2033-02&to=2033-03&service=' + fx.uci._id;
    const before = (await get(admin, q)).body;
    for (let y = 2018; y < 2024; y++) for (let m = 0; m < 12; m++) await sched(svc._id, y, m, { 0: 'T' }); // 72 cuadros viejos de otro servicio
    for (const m of [3, 4, 5]) await sched(fx.uci._id, 2033, m, { 0: 'M' });                                // y tres meses más recientes
    const after = (await get(admin, q)).body;
    expect(after.kpis).toEqual(before.kpis); expect(after.therapists).toEqual(before.therapists); expect(after.scheduleCount).toBe(2);
    expect(after.hoursByMonth.map((x: any) => [x.year, x.month])).toEqual([[2033, 3], [2033, 4], [2033, 5]]); // abril a junio: los tres más recientes
    // sin período: el mes más reciente
    const latest = (await get(admin, '/dashboard')).body;
    expect([latest.from, latest.to]).toEqual(['2033-06', '2033-06']);
    // un período viejo sigue calculándose bien aunque haya meses más nuevos
    const old = (await get(admin, `/dashboard?from=2018-01&to=2018-01&service=${svc._id}`)).body;
    expect(old.scheduleCount).toBe(1); expect(old.kpis.hours).toBe(6);
  });
});
