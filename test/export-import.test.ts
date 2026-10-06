import { existsSync, readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ImportError, assertSafeZip, matchName, normalizeCells, parseWorkbook } from '../src/lib/import-sheet';
import { Schedule, Therapist } from '../src/models/index';
import { app, authed, login, makeFixtures, oid, setupDb, teardownDb } from './helpers';

const api = (p: string) => `/api/v1${p}`;
type Fx = Awaited<ReturnType<typeof makeFixtures>>;
let fx: Fx, admin: string, coord: string, sched: any;
let ana: any, bea: any, cira: any, dora: any;

const day = (n: number, over: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => over[i] ?? 'L');
const download = (token: string, id: unknown, format: string) =>
  request(app).get(api(`/schedules/${id}/export?format=${format}`)).set(authed(token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
const preview = (token: string, serviceId: unknown, file: Buffer) =>
  request(app).post(api(`/schedules/import/preview?serviceId=${serviceId}`)).set(authed(token)).set('Content-Type', 'application/octet-stream').send(file);

beforeAll(async () => {
  await setupDb(); fx = await makeFixtures();
  const mk = (name: string, kind: 'fija' | 'apoyo') => Therapist.create({ name, position: 'Terapeuta respiratoria', defaultKind: kind, serviceIds: [fx.uci._id], active: true });
  [ana, bea, cira, dora] = await Promise.all([mk('Ana Uno', 'fija'), mk('Bea Dos', 'fija'), mk('Cira Tres', 'fija'), mk('Dora Apoyo', 'apoyo')]);
  // UCI · septiembre 2026 (30 días). Ana: M T N, vacaciones del 11 al 13 y un doble el 20 (domingo); Bea: T el 6 (domingo); Dora (apoyo): una mañana
  sched = await Schedule.create({
    serviceId: fx.uci._id, year: 2026, month: 8, status: 'bor', ownerId: fx.admin._id, coverage: { M: 1, T: 1, N: 1 },
    rules: { seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' },
    members: [
      { therapistId: ana._id, kind: 'fija', days: day(30, { 0: 'M', 1: 'T', 2: 'N', 10: 'V', 11: 'V', 12: 'V', 19: 'MT' }), locked: [] },
      { therapistId: bea._id, kind: 'fija', days: day(30, { 5: 'T' }), locked: [] },
      { therapistId: cira._id, kind: 'fija', days: day(30, { 16: 'I', 17: 'I' }), locked: [] },
      { therapistId: dora._id, kind: 'apoyo', days: day(30, { 4: 'M' }), locked: [] }
    ]
  });
  admin = (await login('admin@test.co')).token; coord = (await login('coord@test.co')).token;
});
afterAll(teardownDb);

describe('exportar: formato del hospital', () => {
  it('Excel: encabezado, días, letras del día, dos filas por persona y suma de horas', async () => {
    const r = await download(admin, sched._id, 'xlsx');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(decodeURIComponent(r.headers['content-disposition'].split("filename*=UTF-8''")[1])).toBe('UCI Neurocrítica - Septiembre 2026.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    const ws = wb.getWorksheet('Septiembre 2026')!;
    expect(ws.getCell('B2').value).toBe('PROFESIONALES  UCI NEUROCRÍTICA');
    expect(ws.getCell('B3').value).toBe('CENTRO DE COSTOS: UCI NEUROCRÍTICA');
    expect(ws.getCell('B4').value).toBe('NEIVA, SEPTIEMBRE 2026');
    expect(ws.getCell('B6').value).toBe('FECHA'); expect(ws.getCell('B7').value).toBe('DÍAS');
    expect([ws.getCell('C6').value, ws.getCell('D6').value, ws.getCell('AF6').value]).toEqual([1, 2, 30]);
    expect([ws.getCell('C7').value, ws.getCell('H7').value, ws.getCell('I7').value]).toEqual(['M', 'D', 'L']); // 1 sept 2026 martes; el 6 domingo; el 7 lunes
    expect(ws.getCell('AG6').value).toBe('HORAS');
    // Primera persona (planta, en el orden del cuadro): Ana — fila 8 turnos, fila 9 horas
    expect([ws.getCell('A8').value, ws.getCell('B8').value]).toEqual([1, 'ANA UNO']);
    expect([ws.getCell('C8').value, ws.getCell('D8').value, ws.getCell('E8').value, ws.getCell('F8').value]).toEqual(['M', 'T', 'N', 'L']);
    expect([ws.getCell('C9').value, ws.getCell('D9').value, ws.getCell('E9').value, ws.getCell('F9').value]).toEqual([6, 6, 12, null]);
    expect(ws.getCell('AG9').value).toMatchObject({ formula: 'SUM(C9:AF9)', result: 6 + 6 + 12 + 12 });
    // El apoyo va al final de la planta
    expect(ws.getCell('B14').value).toBe('DORA APOYO');
    expect(ws.getCell('AG15').value).toMatchObject({ result: 6 });
    // Combinaciones: título a lo ancho, número en dos filas
    expect(ws.model.merges).toEqual(expect.arrayContaining(['B2:AF2', 'B3:AF3', 'B4:AF4', 'A8:A9', 'A6:A7', 'AG6:AG7']));
    // Leyenda
    const legend = [] as unknown[]; ws.getColumn(2).eachCell(c => { if (typeof c.value === 'string' && /^(TURNOS|MAÑANA|TARDE|NOCHE)/.test(c.value)) legend.push(c.value); });
    expect(legend).toEqual(['TURNOS', 'MAÑANA : 07:00 - 13:00', 'TARDE : 13:00 - 19:00', 'NOCHE : 19:00 - 07:00']);
  });

  it('Excel: fines de semana en amarillo y ausencias en naranja, como el cuadro del hospital', async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await download(admin, sched._id, 'xlsx')).body);
    const ws = wb.getWorksheet('Septiembre 2026')!;
    const fill = (a: string) => (ws.getCell(a).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fill('H8')).toBe('FFFDE9A9');   // domingo 6
    expect(fill('G8')).toBe('FFFDE9A9');   // sábado 5
    expect(fill('F8')).toBeUndefined();    // viernes 4
    expect(fill('M8')).toBe('FFFC5C00');   // vacaciones (día 11)
    expect(fill('C6')).toBe('FFFDE9A9');   // encabezado de los días
    expect(fill('B6')).toBe('FFC0C0C0');   // encabezado gris
    expect(ws.getCell('C8').border.left?.style).toBe('thin');
    expect(ws.pageSetup.orientation).toBe('landscape');
  });

  it('ODS: paquete válido (mimetype primero y sin comprimir), con estilos, combinaciones y fórmulas', async () => {
    const r = await download(admin, sched._id, 'ods');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/vnd.oasis.opendocument.spreadsheet');
    const zip = await JSZip.loadAsync(r.body);
    const names = Object.keys(zip.files);
    expect(names[0]).toBe('mimetype');
    expect(await zip.file('mimetype')!.async('string')).toBe('application/vnd.oasis.opendocument.spreadsheet');
    expect(r.body.subarray(30, 38).toString()).toBe('mimetype'); // primera entrada del zip
    expect(r.body.readUInt16LE(8)).toBe(0);                      // método 0 = sin comprimir
    const content = await zip.file('content.xml')!.async('string');
    expect(content).toContain('table:formula="of:=SUM([.C9:.AF9])"');
    expect(content).toContain('table:number-columns-spanned="31"');   // título combinado B..AF
    expect(content).toContain('fo:background-color="#FDE9A9"'); expect(content).toContain('fo:background-color="#FC5C00"');
    expect(await zip.file('META-INF/manifest.xml')!.async('string')).toContain('content.xml');
    // Se abre y trae lo mismo que el cuadro
    const x = XLSX.read(r.body, { type: 'buffer' }), ws = x.Sheets['Septiembre 2026'];
    expect(ws.B8.v).toBe('ANA UNO'); expect([ws.C8.v, ws.D8.v, ws.E8.v]).toEqual(['M', 'T', 'N']); expect(ws.C9.v).toBe(6); expect(ws.AG9.v).toBe(36);
  });

  it('exige sesión y alcance, y valida el formato', async () => {
    expect((await request(app).get(api(`/schedules/${sched._id}/export`))).status).toBe(401);
    expect((await download(admin, sched._id, 'pdf')).status).toBe(400);
    await Schedule.create({ serviceId: fx.hos._id, year: 2026, month: 8, ownerId: fx.admin._id, members: [] });
    const other = await Schedule.findOne({ serviceId: fx.hos._id });
    expect((await download(coord, other!._id, 'xlsx')).status).toBe(403);
    expect((await download(admin, oid(), 'xlsx')).status).toBe(404);
  });
});

describe('importar: ida y vuelta con lo exportado', () => {
  for (const format of ['xlsx', 'ods'] as const) {
    it(`${format}: se reconoce la tabla, el mes, los nombres y cada casilla`, async () => {
      const file = (await download(admin, sched._id, format)).body as Buffer;
      const r = await preview(coord, fx.uci._id, file);
      expect(r.status).toBe(200);
      expect(r.body.tables).toHaveLength(1);
      const t = r.body.tables[0];
      expect(t).toMatchObject({ sheet: 'Septiembre 2026', year: 2026, month: 8, days: 30 });
      expect(t.people.map((p: any) => p.name)).toEqual(['ANA UNO', 'BEA DOS', 'CIRA TRES', 'DORA APOYO']);
      expect(t.people.map((p: any) => p.matchId)).toEqual([ana, bea, cira, dora].map(x => String(x._id)));
      expect(t.people.map((p: any) => p.codes)).toEqual((await Schedule.findById(sched._id).lean() as any).members.map((m: any) => m.days));
      expect(t.people.every((p: any) => p.warnings.length === 0)).toBe(true);
    });
  }

  it('crear desde lo leído: cuadro en borrador, personas y turnos iguales, todo fijado a mano', async () => {
    const file = (await download(admin, sched._id, 'xlsx')).body as Buffer;
    const t = (await preview(admin, fx.uci._id, file)).body.tables[0];
    await Schedule.deleteOne({ _id: sched._id }); // se importa en el mismo mes
    const r = await request(app).post(api('/schedules/import')).set(authed(coord)).send({
      serviceId: String(fx.uci._id), year: 2026, month: 8, members: t.people.map((p: any) => ({ therapistId: p.matchId, cells: p.cells }))
    });
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([]);
    const s = r.body.schedule;
    expect(s).toMatchObject({ status: 'bor', year: 2026, month: 8, ownerName: 'Coord Prueba' });
    const m = (id: any) => s.members.find((x: any) => x.therapistId === String(id));
    expect(m(ana._id).days.slice(0, 3)).toEqual(['M', 'T', 'N']); expect(m(ana._id).days[19]).toBe('MT');
    expect(Object.keys(m(ana._id).locked).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 10, 11, 12, 19]); // lo que no es libre queda fijado
    expect(m(ana._id).locked[10]).toBe('V');
    expect(m(dora._id).kind).toBe('apoyo');
    expect(m(cira._id).locked).toEqual({ 16: 'I', 17: 'I' });
    // Repetir el mismo mes es un duplicado
    const dup = await request(app).post(api('/schedules/import')).set(authed(coord)).send({ serviceId: String(fx.uci._id), year: 2026, month: 8, members: t.people.map((p: any) => ({ therapistId: p.matchId, cells: p.cells })) });
    expect(dup.status).toBe(409);
  });

  it('valida: personas repetidas, terapeuta inexistente o inactiva, al menos 2, servicio ajeno', async () => {
    const body = (members: object[], extra: object = {}) => ({ serviceId: String(fx.uci._id), year: 2026, month: 9, members, ...extra });
    const one = { therapistId: String(ana._id), cells: [] as string[] };
    const post = (b: object, token = coord) => request(app).post(api('/schedules/import')).set(authed(token)).send(b);
    expect((await post(body([one, one]))).body.message).toMatch(/repetidas/);
    expect((await post(body([one, { therapistId: oid(), cells: [] }]))).status).toBe(400);
    expect((await post(body([one]))).status).toBe(400);
    await Therapist.updateOne({ _id: bea._id }, { active: false });
    expect((await post(body([one, { therapistId: String(bea._id), cells: [] }]))).status).toBe(400);
    await Therapist.updateOne({ _id: bea._id }, { active: true });
    expect((await post(body([one, { therapistId: String(bea._id), cells: [] }], { serviceId: String(fx.hos._id) }))).status).toBe(403);
  });
});

describe('importar: el lector', () => {
  it('casillas vacías son libres; los turnos y las ausencias reconocidos quedan fijados', () => {
    const r = normalizeCells(['m', '', 'N', 'mt', ' L ', 'V', 'I', 'P', 'vac', ''], 10);
    expect(r.codes).toEqual(['M', 'L', 'N', 'MT', 'L', 'V', 'I', 'P', 'V', 'L']);
    expect(Object.keys(r.locked).map(Number)).toEqual([0, 2, 3, 5, 6, 7, 8]);
    expect(r.warnings).toEqual([]);
  });
  it('las ausencias escritas letra por letra en días seguidos se juntan (PERMISO, ESTUDIO)', () => {
    const p = normalizeCells(['MN', 'L', 'N', 'PE', 'R', 'MI', 'S', 'O', 'N'], 9);
    expect(p.codes).toEqual(['L', 'L', 'N', 'P', 'P', 'P', 'P', 'P', 'N']);
    expect(p.warnings).toEqual(['Día 1: «MN» no se reconoce; quedó libre.']);
    expect(normalizeCells(['T', 'M', 'ES', 'TU', 'DI', 'O', 'N'], 7).codes).toEqual(['T', 'M', 'P', 'P', 'P', 'P', 'N']);
    expect(normalizeCells(['VACACIONES', 'x', 'x'], 3).codes[0]).toBe('V');
    expect(normalizeCells(['IN', 'CA', 'PA', 'CI', 'DAD'], 5).codes).toEqual(['I', 'I', 'I', 'I', 'I']);
  });
  it('lo que no se entiende queda libre y se avisa con el día; sobran o faltan días sin romper', () => {
    const r = normalizeCells(['XYZ', '6', 'M'], 5);
    expect(r.codes).toEqual(['L', 'L', 'M', 'L', 'L']);
    expect(r.warnings).toEqual(['Día 1: «XYZ» no se reconoce; quedó libre.', 'Día 2: «6» no se reconoce; quedó libre.']);
    expect(normalizeCells(['M', 'T', 'N', 'M'], 2).codes).toEqual(['M', 'T']);
  });
  it('nombres: exacto sin tildes ni mayúsculas, o el nombre corto que solo cabe en una persona; si es ambiguo no adivina', () => {
    const pool = [{ id: '1', name: 'María Mercedes Becerra' }, { id: '2', name: 'Maria Fernanda Sánchez' }, { id: '3', name: 'Carolina Sánchez' }, { id: '4', name: 'Sandra Ríos' }];
    expect(matchName('MARIA  MERCEDES BECERRA', pool).matchId).toBe('1');
    expect(matchName('SANDRA RIOS', pool).matchId).toBe('4');
    expect(matchName('MERCEDES BECERRA', pool).matchId).toBe('1');
    const amb = matchName('SÁNCHEZ', pool);
    expect(amb.matchId).toBeNull(); expect(amb.suggestions.map(s => s.id).sort()).toEqual(['2', '3']);
    expect(matchName('XIOMARA MEDINA – ONCOL APOYO', pool).matchId).toBeNull();
  });

  const ws = (rows: unknown[][]) => { const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(rows), 'MAYO_2025'); return Buffer.from(XLSX.write(w, { type: 'buffer', bookType: 'xlsx' })); };
  const header = (n: number) => [['', 'CUADRO DE TURNOS'], ['', 'NEIVA, MAYO 2025'], [], ['No', 'FECHAS', ...Array.from({ length: n }, (_, i) => i + 1), 'HORAS'], ['', 'DIAS']];
  it('el mes sale del encabezado o, si no, del nombre de la hoja; el nombre puede venir en la segunda fila; se detiene en TOTAL', () => {
    const rows = [...header(31), [1, 'ANA UNO', 'M', 'M'], ['', '', 6, 6, 12], ['', '', 'T'], [2, 'BEA DOS', 6], [], [], ['TOTAL DE HORAS']];
    const t = parseWorkbook(ws(rows))[0];
    expect(t).toMatchObject({ sheet: 'MAYO_2025', year: 2025, month: 4, days: 31, headerRow: 4 });
    expect(t.people.map(p => p.name)).toEqual(['ANA UNO', 'BEA DOS']);
    expect(t.people[0].cells.slice(0, 3)).toEqual(['M', 'M', '']);
    expect(t.people[1].cells.slice(0, 1)).toEqual(['T']); // los turnos estaban en la fila de arriba del nombre
    const sinTitulo = ws([['', 'FECHAS', ...Array.from({ length: 30 }, (_, i) => i + 1)], ['', 'DIAS'], ['', 'ANA UNO', 'M']]);
    expect(parseWorkbook(sinTitulo)[0]).toMatchObject({ year: 2025, month: 4 }); // de «MAYO_2025»
  });
  it('rechaza archivos que no son un cuadro con mensajes claros', async () => {
    expect((await preview(admin, fx.uci._id, Buffer.from('esto no es una hoja de cálculo'))).status).toBe(400);
    const vacio = ws([['hola', 'mundo'], [1, 2, 3]]);
    const r = await preview(admin, fx.uci._id, vacio);
    expect(r.status).toBe(400); expect(r.body.code).toBe('IMPORT_EMPTY'); expect(r.body.message).toMatch(/FECHA/);
    expect((await request(app).post(api(`/schedules/import/preview?serviceId=${fx.uci._id}`)).set(authed(admin)).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(0))).status).toBe(400);
    expect((await preview(coord, fx.hos._id, vacio)).status).toBe(403);
    expect((await request(app).post(api(`/schedules/import/preview?serviceId=${fx.uci._id}`)).send(Buffer.from('x'))).status).toBe(401);
  });
});

describe('importar: archivos peligrosos', () => {
  const zipWith = async (files: Record<string, string>) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'nodebuffer' }); };
  /** Cambia el tamaño descomprimido que declara el directorio central (sin crear el contenido enorme). */
  const declare = (buf: Buffer, size: number) => { const b = Buffer.from(buf); for (let i = 0; i < b.length - 4; i++) if (b.readUInt32LE(i) === 0x02014b50) { b.writeUInt32LE(size, i + 24); break; } return b; };
  it('rechaza un zip que al abrirse ocuparía cientos de megas', async () => {
    const bomba = declare(await zipWith({ 'content.xml': 'x' }), 400 * 1024 * 1024);
    expect(() => assertSafeZip(bomba)).toThrow(ImportError);
    expect(() => parseWorkbook(bomba)).toThrow(/demasiado grande/);
    const r = await preview(admin, fx.uci._id, bomba);
    expect(r.status).toBe(400); expect(r.body.code).toBe('IMPORT_UNREADABLE');
  });
  it('un zip normal, uno cortado y un archivo que no es zip no disparan la guarda', async () => {
    const ok = await zipWith({ 'content.xml': '<a/>', 'mimetype': 'x' });
    expect(() => assertSafeZip(ok)).not.toThrow();
    expect(() => assertSafeZip(ok.subarray(0, ok.length - 10))).toThrow(/dañado/);
    expect(() => assertSafeZip(Buffer.from('hola, esto es texto'))).not.toThrow();
  });
});

const REAL = '../frontend/referencia/SEPTIEMBRE_2026_2_1.ods';
describe.skipIf(!existsSync(REAL))('importar: el cuadro real del hospital (SEPTIEMBRE_2026_2_1.ods)', () => {
  const tables = () => parseWorkbook(readFileSync(REAL));
  it('encuentra las tablas de turnos de cada hoja con su mes', () => {
    const t = tables();
    expect(t.length).toBeGreaterThanOrEqual(3);
    const sep = t.find(x => x.sheet === 'SERV-PISO')!;
    expect(sep).toMatchObject({ year: 2026, month: 8, days: 30, headerRow: 6 });
    expect(sep.people.map(p => p.name).slice(0, 6)).toEqual(['CAROLINA SÁNCHEZ', 'MARIA MERCEDES BECERRA', 'MAYRA CERQUERA', 'JESSICA ROMERO', 'SANDRA RIOS', 'GLORIA OQUENDO']);
    expect(t.find(x => x.sheet === 'MAYO_2025')).toMatchObject({ year: 2025, month: 4, days: 28 });
  });
  it('lee los turnos de septiembre: «MN» se avisa y los permisos y estudios escritos letra por letra se juntan', () => {
    const sep = tables().find(x => x.sheet === 'SERV-PISO')!;
    const carolina = normalizeCells(sep.people[0].cells, 30), jessica = normalizeCells(sep.people[3].cells, 30);
    expect(carolina.codes.slice(0, 9)).toEqual(['L', 'L', 'N', 'P', 'P', 'P', 'P', 'P', 'N']); // MN (día 1, sin equivalente) queda libre; «PE R MI S O» = permiso
    expect(carolina.warnings).toEqual(['Día 1: «MN» no se reconoce; quedó libre.']);
    expect(jessica.codes.slice(0, 8)).toEqual(['T', 'M', 'P', 'P', 'P', 'P', 'N', 'T']);        // «ES TU DI O» = estudio
    const mercedes = normalizeCells(sep.people[1].cells, 30);
    expect(mercedes.codes.slice(0, 6)).toEqual(['L', 'L', 'M', 'L', 'L', 'MT']);                  // «MN» del día 4 queda libre
    expect(mercedes.warnings).toHaveLength(1);
  });
});
