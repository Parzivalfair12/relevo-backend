import mongoose from 'mongoose';
import { config } from './config.js';
import { User, Service, Therapist, Schedule, AuditLog } from './models/index.js';

export async function connectDb() {
  mongoose.set('sanitizeFilter', true); // evita inyección de operadores ($ne, $gt...) en filtros
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.MONGO_URI);
  // Alinea los índices con los modelos (por ejemplo el índice parcial de documento): este proyecto es dueño de todos los de su base
  await Promise.all([User, Service, Therapist, Schedule, AuditLog].map(m => m.syncIndexes()));
  return mongoose.connection;
}
export const disconnectDb = () => mongoose.disconnect();
