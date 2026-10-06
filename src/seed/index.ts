/** npm run seed — BORRA y vuelve a cargar los datos de ejemplo del mockup. Solo para desarrollo. */
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../db.js';
import { User, Service, Therapist, Schedule, AuditLog } from '../models/index.js';
import { SEED_USERS, SEED_SERVICES, SEED_THERAPISTS, buildSeedSchedules } from './data.js';
import { isProd } from '../config.js';

if (isProd) { console.error('El seed no corre en producción.'); process.exit(1); }
await connectDb();
await Promise.all([User, Service, Therapist, Schedule, AuditLog].map(m => m.deleteMany({})));

const id = () => new mongoose.Types.ObjectId();
const svc = new Map(SEED_SERVICES.map(s => [s.key, id()]));
const ther = new Map(SEED_THERAPISTS.map(t => [t.key, id()]));
const usr = new Map(SEED_USERS.map(u => [u.key, id()]));

await Service.insertMany(SEED_SERVICES.map(s => ({ _id: svc.get(s.key), name: s.name, color: s.color })));
await Therapist.insertMany(SEED_THERAPISTS.map(t => ({
  _id: ther.get(t.key), name: t.name, document: t.document, position: t.position,
  defaultKind: t.defaultKind, serviceIds: t.serviceKeys.map(k => svc.get(k)), active: t.active
})));
await User.insertMany(await Promise.all(SEED_USERS.map(async u => ({
  _id: usr.get(u.key), name: u.name, email: u.email, role: u.role, status: 'activo',
  passwordHash: await argon2.hash(u.password, { type: argon2.argon2id }), serviceIds: u.serviceKeys.map(k => svc.get(k))
}))));
await Schedule.insertMany(buildSeedSchedules().map(s => ({
  serviceId: svc.get(s.serviceKey), year: s.year, month: s.month, status: s.status, ownerId: usr.get(s.ownerKey),
  coverage: s.coverage, rules: s.rules, seed: s.seed,
  members: s.members.map(m => ({ therapistId: ther.get(m.therapistKey), kind: m.kind, days: m.days, locked: m.locked }))
})));

console.log(`Seed listo: ${SEED_USERS.length} usuarios, ${SEED_SERVICES.length} servicios, ${SEED_THERAPISTS.length} terapeutas, ${buildSeedSchedules().length} cuadros.`);
await disconnectDb();
