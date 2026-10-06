import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectDb, disconnectDb } from '../src/db';
import { AuditLog, Schedule, Service, Therapist, User } from '../src/models/index';
import { hashPassword } from '../src/lib/tokens';

export const app = createApp();
export const PW = 'clave-segura-1';

/** Base de pruebas aparte (turnos_test): se vacía antes de cada archivo. */
export async function setupDb() {
  await connectDb();
  await Promise.all([User, Service, Therapist, Schedule, AuditLog].map(m => m.deleteMany({})));
}
export const teardownDb = () => disconnectDb();

export async function makeFixtures() {
  const [uci, hos] = await Service.create([{ name: 'UCI Neurocrítica', color: '#2BB3BD' }, { name: 'Hospitalización', color: '#F29E6B' }]);
  const passwordHash = await hashPassword(PW);
  const mk = (name: string, email: string, role: 'admin' | 'coord', serviceIds: unknown[] = [], status: 'activo' | 'pendiente' = 'activo') =>
    User.create({ name, email, role, status, serviceIds, passwordHash });
  const admin = await mk('Admin Prueba', 'admin@test.co', 'admin');
  const coord = await mk('Coord Prueba', 'coord@test.co', 'coord', [uci._id]);
  return { uci, hos, admin, coord };
}

export async function login(email: string, password = PW) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return { res, token: res.body.accessToken as string, cookies: res.headers['set-cookie'] as unknown as string[] | undefined };
}
export const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
export const oid = () => String(new mongoose.Types.ObjectId());
