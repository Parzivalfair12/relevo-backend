import type { Request } from 'express';
import type mongoose from 'mongoose';
import { AuditLog } from '../models/index.js';

type Id = string | mongoose.Types.ObjectId;

/** Registro de quién creó, editó o eliminó algo. Un fallo al auditar no debe tumbar la operación. */
export async function audit(req: Request, action: string, entity: 'user' | 'service' | 'therapist' | 'schedule', entityId: Id, summary: string) {
  try { await AuditLog.create({ userId: req.user?.id, action, entity, entityId, summary }); }
  catch (e) { console.error('auditoría', e); }
}
