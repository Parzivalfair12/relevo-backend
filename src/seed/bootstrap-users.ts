/**
 * npm run users:bootstrap — crea o actualiza las cuentas del administrador y de Savitra con lo que hay en el .env.
 * A diferencia de `npm run seed`, NO borra nada y sirve también en producción. Se puede correr las veces que haga falta:
 * si la cuenta ya existe (por correo), le deja la contraseña, el rol y los servicios del .env.
 * Nunca imprime contraseñas.
 */
import argon2 from 'argon2';
import { connectDb, disconnectDb } from '../db.js';
import { User, Service } from '../models/index.js';
import { config } from '../config.js';

interface Account { label: string; name?: string; email?: string; password?: string; role: 'admin' | 'coord' }
const accounts: Account[] = [
  { label: 'Administrador', name: config.ADMIN_NAME, email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD, role: 'admin' },
  { label: 'Savitra', name: config.SAVITRA_NAME, email: config.SAVITRA_EMAIL, password: config.SAVITRA_PASSWORD, role: 'coord' }
];

await connectDb();
// Savitra firma los cuadros de todos los servicios; el administrador ve todo sin necesitar servicios asignados
const allServices = (await Service.find().select('_id').lean()).map(s => s._id);

let created = 0, updated = 0;
for (const a of accounts) {
  if (!a.name || !a.email || !a.password) {
    console.error(`${a.label}: faltan variables en el .env (nombre, correo o contraseña); no se crea.`);
    continue;
  }
  const passwordHash = await argon2.hash(a.password, { type: argon2.argon2id });
  const set = { name: a.name, role: a.role, status: 'activo', passwordHash, serviceIds: a.role === 'admin' ? [] : allServices };
  const r = await User.updateOne({ email: a.email }, { $set: set, $setOnInsert: { email: a.email } }, { upsert: true });
  if (r.upsertedCount) created++; else updated++;
  console.log(`${a.label}: ${r.upsertedCount ? 'creada' : 'actualizada'} (${a.email})`);
}
if (created + updated === 0) console.error('No se creó ninguna cuenta.');
console.log(`Listo: ${created} creadas, ${updated} actualizadas.`);
await disconnectDb();
