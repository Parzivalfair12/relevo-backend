import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { plain, serviceFor } from '../src/lib/import-sheet';
import { AuditLog, Schedule, Service, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string, ana: any, bea: any;

const svc = (name: string, id = name) => ({ id, key: plain(name) });
const days = (n: number) => Array.from({ length: n }, () => 'M');

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  const mk = (name: string, active = true) => Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: 'fija', serviceIds: [fx.uci._id], active });
  [ana, bea] = await Promise.all([mk('Ana Uno'), mk('Bea Dos')]);
  await mk('Inés Inactiva', false);
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(teardownDb);

describe('servicio de una tabla por su título o por la abreviatura de la hoja', () => {
  const list = [svc('UCI Neurocrítica'), svc('Hospitalización 7° piso'), svc('Urgencias')];
  it('el nombre completo en el título o la hoja, sin importar tildes ni mayúsculas', () => {
    expect(serviceFor({ title: 'PROFESIONALES  UCI  NEUROCRITICA · NEIVA, SEPTIEMBRE 2026', sheet: 'Hoja5' }, list)).toBe('UCI Neurocrítica');
    expect(serviceFor({ title: 'MÉDICOS · HOSPITALIZACIÓN 7 PISO', sheet: 'MAYO_2025' }, list)).toBe('Hospitalización 7° piso');
    expect(serviceFor({ title: '.', sheet: 'urgencias' }, list)).toBe('Urgencias');
  });
  it('si hay nombres anidados elige el más específico; si compiten dos distintos, no adivina', () => {
    const nested = [svc('Hospitalización'), svc('Hospitalización 7° piso')];
    expect(serviceFor({ title: 'HOSPITALIZACIÓN 7 PISO', sheet: 'x' }, nested)).toBe('Hospitalización 7° piso');
    expect(serviceFor({ title: 'UCI NEUROCRITICA Y URGENCIAS', sheet: 'x' }, list)).toBeNull();
  });
  it('reconoce abreviaturas del nombre de la hoja, ignorando meses, años y palabras de costumbre', () => {
    for (const sheet of ['UCI', 'uci', 'UCI NEURO', 'UCI_SEPTIEMBRE_2026', 'Copia de UCI', 'TURNOS UCI']) expect([sheet, serviceFor({ title: '.', sheet }, list)]).toEqual([sheet, 'UCI Neurocrítica']);
    expect(serviceFor({ title: '.', sheet: 'HOSP' }, list)).toBe('Hospitalización 7° piso');
    expect(serviceFor({ title: '.', sheet: 'SERV-PISO' }, list)).toBe('Hospitalización 7° piso');
  });
  it('sin pistas claras devuelve null', () => {
    for (const sheet of ['Hoja5', 'MAYO_2025', '___', 'COPIA DE FEBRERO 2023', 'Otro', 'U']) expect([sheet, serviceFor({ title: 'PROFESIONALES · NEIVA', sheet }, list)]).toEqual([sheet, null]);
    expect(serviceFor({ title: '.', sheet: 'HOSP' }, [svc('Hospitalización'), svc('Hospital de día')])).toBeNull(); // dos servicios empiezan igual
  });
  it('la vista previa lo usa cuando no se eligió servicio', async () => {
    const book = (sheet: string) => { const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([['', 'CUADRO DE TURNOS'], ['', 'NEIVA, SEPTIEMBRE 2026'], [], ['No', 'FECHAS', ...Array.from({ length: 30 }, (_, i) => i + 1), 'HORAS'], ['', 'DIAS'], [1, 'ANA UNO', 'M', 'M'], [2, 'BEA DOS', 'T']]), sheet); return Buffer.from(XLSX.write(w, { type: 'buffer', bookType: 'xlsx' })); };
    const prev = (sheet: string) => request(app).post(api('/schedules/import/preview')).set(authed(admin)).set('Content-Type', 'application/octet-stream').send(book(sheet));
    expect((await prev('UCI')).body.tables[0].serviceId).toBe(String(fx.uci._id));
    expect((await prev('Hospitaliz')).body.tables[0].serviceId).toBe(String(fx.hos._id));
    expect((await prev('Hoja5')).body.tables[0].serviceId).toBeNull();
  });
});

describe('registrar terapeutas nuevas al importar', () => {
  const body = (month: number, members: object[], extra: object = {}) => ({ serviceId: String(fx.uci._id), year: 2031, month, members, ...extra });
  const post = (token: string, b: object) => request(app).post(api('/schedules/import')).set(authed(token)).send(b);
  const known = () => ({ therapistId: String(ana._id), cells: days(30) });

  it('un administrador la registra, queda en el cuadro y en el directorio, y se audita', async () => {
    const r = await post(admin, body(0, [known(), { newName: 'Eva Nueva Ríos', kind: 'apoyo', cells: days(30) }]));
    expect(r.status).toBe(201);
    const eva: any = await Therapist.findOne({ name: 'Eva Nueva Ríos' });
    expect(eva).toMatchObject({ active: true, defaultKind: 'apoyo', position: 'Terapeuta respiratoria' });
    expect(eva.serviceIds.map(String)).toEqual([String(fx.uci._id)]);
    expect(r.body.schedule.members.map((m: any) => m.name).sort()).toEqual(['Ana Uno', 'Eva Nueva Ríos']);
    expect(r.body.schedule.members.find((m: any) => m.name === 'Eva Nueva Ríos').kind).toBe('apoyo');
    expect(await AuditLog.countDocuments({ entity: 'therapist', summary: /Registró a Eva Nueva Ríos al importar el cuadro de UCI Neurocrítica 1\/2031/ })).toBe(1);
  });
  it('una coordinadora no puede registrar personas: 403 y no se crea nada', async () => {
    const before = await Therapist.countDocuments({});
    const r = await post(coord, body(1, [known(), { newName: 'Fran Nueva', cells: days(30) }]));
    expect(r.status).toBe(403); expect(r.body.message).toMatch(/Solo un administrador/);
    expect(await Therapist.countDocuments({})).toBe(before);
    expect(await Schedule.countDocuments({ year: 2031, month: 1 })).toBe(0);
  });
  it('si ya existe alguien con ese nombre (sin tildes ni mayúsculas) usa a esa persona en vez de crear otra', async () => {
    const before = await Therapist.countDocuments({});
    const r = await post(admin, body(2, [known(), { newName: 'BEA  DÓS', cells: days(30) }]));
    expect(r.status).toBe(201);
    expect(await Therapist.countDocuments({})).toBe(before);
    expect(r.body.schedule.members.map((m: any) => m.therapistId)).toContain(String(bea._id));
  });
  it('rechaza repetidas, inactivas y entradas mal formadas, sin crear nada', async () => {
    const before = await Therapist.countDocuments({});
    expect((await post(admin, body(3, [known(), { newName: 'Ana Uno', cells: days(30) }]))).status).toBe(400); // Ana ya está elegida por su id
    expect((await post(admin, body(3, [{ newName: 'Gaby Nueva', cells: [] }, { newName: 'gaby  nueva', cells: [] }]))).status).toBe(400);
    const inactive = await post(admin, body(3, [known(), { newName: 'Ines Inactiva', cells: days(30) }]));
    expect(inactive.status).toBe(400); expect(inactive.body.message).toMatch(/inactiva/);
    expect((await post(admin, body(3, [known(), { therapistId: String(bea._id), newName: 'Bea Dos', cells: [] }]))).status).toBe(400); // las dos cosas
    expect((await post(admin, body(3, [known(), { cells: [] }]))).status).toBe(400);                                                      // ninguna
    expect((await post(admin, body(3, [known(), { newName: 'Al', cells: [] }]))).status).toBe(400);                                     // nombre muy corto
    expect(await Therapist.countDocuments({})).toBe(before);
  });
  it('si el cuadro no llega a crearse, las personas registradas se deshacen', async () => {
    const before = await Therapist.countDocuments({});
    const spy = vi.spyOn(Schedule, 'create').mockRejectedValueOnce(new Error('falla simulada'));
    const r = await post(admin, body(4, [known(), { newName: 'Hilda Temporal', cells: days(30) }]));
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(await Therapist.countDocuments({ name: 'Hilda Temporal' })).toBe(0);
    expect(await Therapist.countDocuments({})).toBe(before);
  });
  it('en un lote, la misma persona nueva en varios cuadros se registra una sola vez', async () => {
    const t = (month: number) => body(month, [known(), { newName: 'Jimena Lote', cells: days(30) }]);
    const r = await request(app).post(api('/schedules/import/batch')).set(authed(admin)).send({ tables: [t(5), t(6)] });
    expect(r.status).toBe(201);
    expect(r.body.results.map((x: any) => !!x.schedule)).toEqual([true, true]);
    expect(await Therapist.countDocuments({ name: 'Jimena Lote' })).toBe(1);
    const ids = r.body.results.map((x: any) => x.schedule.members.find((m: any) => m.name === 'Jimena Lote').therapistId);
    expect(ids[0]).toBe(ids[1]);
    expect(await Service.countDocuments({})).toBe(2); // nada más cambió
  });
});
