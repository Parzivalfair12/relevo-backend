import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Schedule, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, oid, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string;
let ana: any, bea: any, cira: any, dora: any, eva: any; // ana, bea, cira: UCI · dora: apoyo UCI · eva: Hospitalización
const get = (token: string, qs = '') => request(app).get(api(`/dashboard${qs}`)).set(authed(token));

const day = (n: number, over: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => over[i] ?? 'L');
/** Rotación completa M·T·N entre tres personas: cubre todos los días sin dejar huecos. */
const rotation = (n: number, shift: number) => Array.from({ length: n }, (_, i) => (['M', 'T', 'N'] as const)[(i + shift) % 3]);
const mkSchedule = (serviceId: unknown, year: number, month: number, members: [any, 'fija' | 'apoyo', string[]][], status: 'bor' | 'pub' = 'pub') =>
  Schedule.create({
    serviceId, year, month, status, ownerId: fx.admin._id, coverage: { M: 1, T: 1, N: 1 },
    rules: { seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' },
    members: members.map(([t, kind, days]) => ({ therapistId: t._id, kind, days, locked: [] }))
  });

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  const mk = (name: string, kind: 'fija' | 'apoyo', serviceIds: unknown[]) => Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: kind, serviceIds, active: true });
  [ana, bea, cira, dora] = await Promise.all([mk('Ana Uno', 'fija', [fx.uci._id]), mk('Bea Dos', 'fija', [fx.uci._id]), mk('Cira Tres', 'fija', [fx.uci._id]), mk('Dora Apoyo', 'apoyo', [fx.uci._id])]);
  eva = await mk('Eva Hos', 'fija', [fx.hos._id]);
  // UCI · agosto 2026 (31 días), publicado. Cobertura completa: rotación M·T·N entre Ana, Bea y Cira
  await mkSchedule(fx.uci._id, 2026, 7, [[ana, 'fija', rotation(31, 0)], [bea, 'fija', rotation(31, 1)], [cira, 'fija', rotation(31, 2)], [dora, 'apoyo', day(31)]]);
  // UCI · septiembre 2026 (30 días), borrador. Ana: M,T,N en los 3 primeros días y 3 de vacaciones; Dora (apoyo): 1 mañana; Bea y Cira: sin turnos
  await mkSchedule(fx.uci._id, 2026, 8, [
    [ana, 'fija', day(30, { 0: 'M', 1: 'T', 2: 'N', 10: 'V', 11: 'V', 12: 'V' })], [bea, 'fija', day(30)], [cira, 'fija', day(30)], [dora, 'apoyo', day(30, { 4: 'M' })]
  ], 'bor');
  // Hospitalización · septiembre 2026: Eva trabaja M el día 1 de septiembre (Ana también: cruce entre servicios) y un doble MT el día 20
  await mkSchedule(fx.hos._id, 2026, 8, [[eva, 'fija', day(30, { 0: 'M', 19: 'MT' })], [ana, 'fija', day(30, { 0: 'T' })]], 'pub');
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(teardownDb);

describe('resumen: acceso', () => {
  it('sin sesión 401; período mal escrito o invertido 400', async () => {
    expect((await request(app).get(api('/dashboard'))).status).toBe(401);
    expect((await get(admin, '?from=2026-13')).status).toBe(400);
    expect((await get(admin, '?from=2026-9')).status).toBe(400);
    const inv = await get(admin, '?from=2026-09&to=2026-08');
    expect(inv.status).toBe(400); expect(inv.body.message).toMatch(/no puede ser posterior/);
  });
  it('la coordinadora solo recibe sus servicios y no puede pedir otro (403)', async () => {
    expect((await get(coord, `?service=${fx.hos._id}`)).status).toBe(403);
    const r = await get(coord, '?from=2026-08&to=2026-09');
    expect(r.status).toBe(200);
    expect(r.body.scheduleCount).toBe(2); // solo los 2 de UCI
    expect(r.body.therapists.map((t: any) => t.name).sort()).toEqual(['Ana Uno', 'Bea Dos', 'Cira Tres', 'Dora Apoyo']); // Eva (Hospitalización) no aparece
    expect(r.body.hoursByService).toEqual([{ serviceId: String(fx.uci._id), hours: expect.any(Number) }]);
  });
});

describe('resumen: cifras', () => {
  it('sin período toma el mes más reciente con cuadros', async () => {
    const r = await get(admin);
    expect(r.body).toMatchObject({ from: '2026-09', to: '2026-09', scheduleCount: 2 });
  });

  it('septiembre, todos los servicios: horas, personas con turnos, apoyo, ausencias y días cubiertos', async () => {
    const r = await get(admin, '?from=2026-09&to=2026-09');
    // Ana 6+6+12 (UCI) con T del día 1 en Hospitalización (cruce, gana el turno de trabajo del último cuadro); Eva 6+12 (M y MT=12); Dora 6
    const byName = Object.fromEntries(r.body.therapists.map((t: any) => [t.name, t]));
    expect(byName['Ana Uno'].hours).toBe(24);   // M→T en la fusión del día 1, T y N de los días 2 y 3 (el cuadro de Hospitalización se aplica después)
    expect(byName['Eva Hos'].hours).toBe(18);
    expect(byName['Dora Apoyo'].hours).toBe(6);
    expect(byName['Bea Dos'].hours).toBe(0);
    expect(r.body.kpis).toMatchObject({ hours: 24 + 18 + 6, activeTherapists: 3, idleTherapists: 2, supportHours: 6, supportPct: 13, absenceDays: 3, totalDays: 60 });
    // Días sin cubrir: ningún día tiene M, T y N completos en ninguno de los dos cuadros
    expect(r.body.kpis.gapDays).toBe(60);
    expect(r.body.kpis.coveragePct).toBe(0);
  });

  it('cada terapeuta: turnos M·T·N, fines de semana, «trabaja cada», descanso medio y patrón', async () => {
    const r = await get(admin, '?from=2026-09&to=2026-09&service=' + fx.uci._id);
    const ana2 = r.body.therapists.find((t: any) => t.name === 'Ana Uno');
    expect(ana2).toMatchObject({ hours: 24, M: 1, T: 1, N: 1, workDays: 3, days: 30, absDays: 3, maxRun: 3, kinds: ['fija'], serviceIds: [String(fx.uci._id)] });
    expect(ana2.everyDays).toBeCloseTo(10, 5);      // 30 días / 3 días trabajados
    expect(ana2.restAvg).toBe(0);                    // un solo bloque de trabajo: no hay descanso entre bloques
    expect(ana2.pattern).toHaveLength(30);
    expect(ana2.pattern.slice(0, 4)).toEqual(['M', 'T', 'N', 'L']);
    expect(ana2.pattern[10]).toBe('V');
    const dora2 = r.body.therapists.find((t: any) => t.name === 'Dora Apoyo');
    expect(dora2).toMatchObject({ M: 1, kinds: ['apoyo'], restAvg: 0 });
  });

  it('un doble MT cuenta como mañana y como tarde (12 h) y los fines de semana se cuentan por fecha', async () => {
    const r = await get(admin, '?from=2026-09&to=2026-09&service=' + fx.hos._id);
    const eva2 = r.body.therapists.find((t: any) => t.name === 'Eva Hos');
    expect(eva2).toMatchObject({ hours: 18, M: 2, T: 1, N: 0, workDays: 2 }); // M el día 1 + MT el día 20
    // 1 de septiembre de 2026 es martes y el 20 es domingo: un turno en fin de semana
    expect(eva2.weekendDays).toBe(1);
  });

  it('un período de varios meses junta los cuadros y calcula el descanso entre bloques', async () => {
    const r = await get(admin, '?from=2026-08&to=2026-09&service=' + fx.uci._id);
    expect(r.body.scheduleCount).toBe(2);
    const bea2 = r.body.therapists.find((t: any) => t.name === 'Bea Dos');
    expect(bea2.pattern).toHaveLength(61);
    // Bea rota todo agosto (siempre trabaja: sin descansos entre bloques) y no trabaja en septiembre
    expect(bea2.hours).toBe(rotation(31, 1).reduce((a, c) => a + (c === 'N' ? 12 : 6), 0));
    expect(bea2.restAvg).toBe(0);
    // Agosto: cobertura completa; septiembre: todos los días con huecos → 31 de 61 días cubiertos
    expect(r.body.kpis).toMatchObject({ totalDays: 61, gapDays: 30, coveragePct: 51 });
  });

  it('horas por mes (los últimos tres con cuadros, de menor a mayor) y por servicio', async () => {
    const r = await get(admin, '?from=2026-09&to=2026-09');
    expect(r.body.hoursByMonth.map((m: any) => [m.year, m.month])).toEqual([[2026, 7], [2026, 8]]);
    const sep = r.body.hoursByMonth[1];
    // Suma cruda de los cuadros (sin fusionar): mañanas de Ana, Dora, Eva y el MT de Eva; tardes de Ana (UCI), Ana (Hospitalización) y el MT; noche de Ana
    expect(sep).toMatchObject({ M: 24, T: 18, N: 12, total: 54 });
    expect(r.body.hoursByService.find((x: any) => x.serviceId === String(fx.uci._id)).hours).toBe(24 + 6);
    expect(r.body.hoursByService.find((x: any) => x.serviceId === String(fx.hos._id)).hours).toBe(18 + 6);
  });
});

describe('resumen: tarjetas de atención', () => {
  it('borradores, cruces entre servicios, horas, noches y gente sin turnos', async () => {
    const r = await get(admin, '?from=2026-09&to=2026-09');
    const titles = r.body.insights.map((i: any) => i.title);
    expect(titles).toContain('1 cuadro(s) en borrador.');
    expect(titles).toContain('2 cruce(s) entre servicios.'); // el mismo cruce se cuenta en cada uno de los dos cuadros, como en el mockup
    expect(titles.some((t: string) => /^Horas (desiguales|parejas)/.test(t))).toBe(true);
    expect(titles).toContain('Más noches:');
    const idle = r.body.insights.find((i: any) => i.title === 'Sin turnos:');
    expect(idle.text).toBe('Bea, Cira.');
    expect(r.body.insights.find((i: any) => /cruce/.test(i.title)).tone).toBe('w');
  });
  it('si todo está publicado y no hay cruces, no avisa de borradores ni cruces', async () => {
    const r = await get(admin, '?from=2026-08&to=2026-08');
    expect(r.body.insights.map((i: any) => i.title).filter((t: string) => /borrador|cruce/.test(t))).toEqual([]);
    expect(r.body.insights.find((i: any) => i.title === 'Horas parejas en planta.')).toBeTruthy(); // la rotación reparte parejo
    expect(r.body.kpis.coveragePct).toBe(100);
  });
  it('un período sin cuadros devuelve ceros, no un error', async () => {
    const r = await get(admin, '?from=2025-01&to=2025-02');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scheduleCount: 0, therapists: [], insights: [], kpis: { hours: 0, coveragePct: 100, activeTherapists: 0 } });
  });
});

describe('resumen: detalle de una terapeuta', () => {
  it('trae sus cifras y el patrón de cada mes', async () => {
    const r = await request(app).get(api(`/dashboard/therapists/${ana._id}?from=2026-08&to=2026-09`)).set(authed(admin));
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Ana Uno');
    expect(r.body.months.map((m: any) => [m.month, m.days.length])).toEqual([[7, 31], [8, 30]]);
    expect(r.body.months[1].hours).toBe(24);
    expect(r.body.serviceIds.sort()).toEqual([String(fx.uci._id), String(fx.hos._id)].sort()); // aparece en dos servicios
  });
  it('404 si no tiene turnos en el período o el id es inválido; la coordinadora no ve a quien trabaja en un servicio ajeno', async () => {
    expect((await request(app).get(api(`/dashboard/therapists/${oid()}`)).set(authed(admin))).status).toBe(404);
    expect((await request(app).get(api('/dashboard/therapists/xx')).set(authed(admin))).status).toBe(404);
    expect((await request(app).get(api(`/dashboard/therapists/${eva._id}?from=2026-09&to=2026-09`)).set(authed(coord))).status).toBe(404);
  });
});
