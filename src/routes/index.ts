import { Router } from 'express';
import mongoose from 'mongoose';
import { auth } from './auth.js';
import { users } from './users.js';
import { services } from './services.js';
import { therapists } from './therapists.js';
import { schedules } from './schedules.js';
import { dashboard } from './dashboard.js';

/** Todas las rutas cuelgan de /api/v1, una carpeta de rutas por grupo del plan. Las de Excel y ODS llegan en la fase 5. */
export const api = Router();

/** `/health`: el proceso responde (vivo). `/health/ready`: además hay conexión con la base (listo para recibir tráfico). */
api.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
api.get('/health/ready', async (_req, res) => {
  try { await mongoose.connection.db!.admin().ping(); res.json({ ok: true, db: 'up' }); }
  catch { res.status(503).json({ ok: false, db: 'down' }); }
});

// Fase 2 · cuentas y directorio
api.use('/auth', auth);
api.use('/users', users);
api.use('/services', services);
api.use('/therapists', therapists);

// Fase 3 · cuadros y editor
api.use('/schedules', schedules);

// Fase 4 · resumen
api.use('/dashboard', dashboard);
