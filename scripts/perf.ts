/**
 * Medición de rendimiento con datos realistas: 3 servicios × 24 meses × 10 personas = 72 cuadros.
 *
 *   npm run perf
 *
 * Usa una base APARTE (`turnos_perf`, la crea y la borra al terminar): nunca toca `turnos`.
 * Imprime, por operación, la mediana y el percentil 95 en milisegundos y el tamaño de la respuesta.
 */
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { generate, type Config, type Person } from '../src/engine/index.js';
import { closeGenerator } from '../src/lib/generate.js';
import { signAccess } from '../src/lib/tokens.js';
import { Schedule, Service, Therapist, User } from '../src/models/index.js';
import { defaultRules } from '../src/shared/index.js';

const uri = process.env.MONGO_URI ?? '';
if (!/\/turnos_perf(\?|$)/.test(uri)) {
  console.error('Este script solo corre sobre la base turnos_perf, porque la BORRA al terminar.\nEjemplo: MONGO_URI="mongodb://127.0.0.1:27018/turnos_perf?replicaSet=rs0&directConnection=true" npm run perf');
  process.exit(1);
}
await connectDb();
await Promise.all([User, Service, Therapist, Schedule].map(m => m.deleteMany({})));

const SERVICES = 3, MONTHS = 24, PEOPLE = 10; // 7 de planta + 3 de apoyo por servicio
const admin = await User.create({ name: 'Perf Admin', email: 'perf@turnos.demo', role: 'admin', status: 'activo', passwordHash: 'x' });
const svcs = (await Service.insertMany(Array.from({ length: SERVICES }, (_, i) => ({ name: `Servicio ${i + 1}`, color: '#2BB3BD' })))) as any[];
const people = (await Therapist.insertMany(Array.from({ length: SERVICES * PEOPLE }, (_, i) => ({
  name: `Terapeuta ${String(i + 1).padStart(2, '0')}`, position: 'Terapeuta respiratoria', defaultKind: i % PEOPLE < 7 ? 'fija' : 'apoyo', serviceIds: [svcs[Math.floor(i / PEOPLE)]._id], active: true
})))) as any[];

const times = (name: string) => ({ name, ms: [] as number[], bytes: 0 });
const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] }; };

// --- Motor: generar un mes (con «Igualar horas», la parte más cara) según el tamaño del equipo
const rows: { name: string; ms: number[]; bytes: number }[] = [];
for (const n of [7, 10, 15, 25]) {
  const t = times(`motor: generar un mes con ${n} personas`);
  const staff: Person[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: i < Math.ceil(n * 0.7) ? 'fija' : 'apoyo' }));
  for (let k = 0; k < 8; k++) {
    const cfg: Config = { year: 2026, month: k % 12, staff, cov: { M: 1, T: 1, N: 1 }, rules: defaultRules(), locked: {}, seed: k + 1 };
    const t0 = performance.now(); generate(cfg); t.ms.push(performance.now() - t0);
  }
  rows.push(t);
}

// --- Datos: 72 cuadros generados con el motor
const t0 = performance.now();
const docs = [];
for (let s = 0; s < SERVICES; s++) for (let m = 0; m < MONTHS; m++) {
  const year = 2025 + Math.floor(m / 12), month = m % 12;
  const team = people.slice(s * PEOPLE, (s + 1) * PEOPLE);
  const staff: Person[] = team.map(t => ({ id: String(t._id), name: t.name, kind: t.defaultKind as 'fija' | 'apoyo' }));
  const grid = generate({ year, month, staff, cov: { M: 1, T: 1, N: 1 }, rules: defaultRules(), locked: {}, seed: m + 1 });
  docs.push({ serviceId: svcs[s]._id, year, month, status: m < MONTHS - 1 ? 'pub' : 'bor', ownerId: admin._id, coverage: { M: 1, T: 1, N: 1 }, rules: defaultRules(), seed: m + 1,
    members: team.map(t => ({ therapistId: t._id, kind: t.defaultKind, days: grid[String(t._id)], locked: [] })) });
}
await Schedule.insertMany(docs);
console.log(`Datos listos: ${docs.length} cuadros × ${PEOPLE} personas (${Math.round(performance.now() - t0)} ms para generarlos y guardarlos)\n`);

// --- API
const app = createApp(), auth = { Authorization: `Bearer ${signAccess(String(admin._id), 'admin')}` };
const any = (await Schedule.findOne({ year: 2026, month: 5 }).lean()) as any;
const bin = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
async function measure(name: string, n: number, call: () => request.Test) {
  const t = times(`API: ${name}`);
  for (let i = 0; i < n; i++) { const a = performance.now(); const r = await call().set(auth).buffer(true).parse(bin); t.ms.push(performance.now() - a); if (r.status !== 200) throw new Error(`${name}: ${r.status}`); t.bytes = (r.body as Buffer).length; }
  rows.push(t);
}
await measure(`lista de cuadros (${docs.length})`, 15, () => request(app).get('/api/v1/schedules'));
await measure('abrir un cuadro', 25, () => request(app).get(`/api/v1/schedules/${any._id}`));
await measure('resumen de 1 mes', 15, () => request(app).get('/api/v1/dashboard?from=2026-06&to=2026-06'));
await measure('resumen de 3 meses', 15, () => request(app).get('/api/v1/dashboard?from=2026-04&to=2026-06'));
await measure('resumen de 12 meses', 10, () => request(app).get('/api/v1/dashboard?from=2025-07&to=2026-06'));
await measure('exportar a Excel', 10, () => request(app).get(`/api/v1/schedules/${any._id}/export?format=xlsx`));
await measure('exportar a ODS', 10, () => request(app).get(`/api/v1/schedules/${any._id}/export?format=ods`));
// Generar (worker): cada vuelta usa la versión vigente
let ver = (await Schedule.findById(any._id).lean() as any).__v;
{
  const t = times('API: generar un cuadro de 10 personas (worker)');
  for (let i = 0; i < 10; i++) { const a = performance.now(); const r = await request(app).post(`/api/v1/schedules/${any._id}/generate`).set(auth).send({ version: ver, variant: true }); t.ms.push(performance.now() - a); if (r.status !== 200) throw new Error(`generar: ${r.status}`); ver = r.body.version; t.bytes = JSON.stringify(r.body).length; }
  rows.push(t);
}
// Pintar una casilla (la operación más frecuente del editor)
{
  const t = times('API: guardar un lote de casillas pintadas');
  const m0 = String(any.members[0].therapistId);
  for (let i = 0; i < 25; i++) { const a = performance.now(); const r = await request(app).put(`/api/v1/schedules/${any._id}/cells`).set(auth).send({ version: ver, changes: [{ therapistId: m0, day: i % 28, code: 'M' }] }); t.ms.push(performance.now() - a); if (r.status !== 200) throw new Error(`cells: ${r.status}`); ver = r.body.version; t.bytes = JSON.stringify(r.body).length; }
  rows.push(t);
}

console.log('operación'.padEnd(54), 'mediana'.padStart(9), 'p95'.padStart(8), 'respuesta'.padStart(11));
for (const r of rows) { const s = stat(r.ms); console.log(r.name.padEnd(54), `${s.p50.toFixed(0)} ms`.padStart(9), `${s.p95.toFixed(0)} ms`.padStart(8), (r.bytes ? `${(r.bytes / 1024).toFixed(1)} KB` : '').padStart(11)); }

await Promise.all([User, Service, Therapist, Schedule].map(m => m.deleteMany({})));
await mongoose.connection.dropDatabase();
await closeGenerator(); await disconnectDb();
