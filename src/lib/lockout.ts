import type mongoose from 'mongoose';
import { User } from '../models/index.js';

/** Bloqueo temporal: tras LOCK_AFTER intentos fallidos seguidos la cuenta no entra durante LOCK_MINUTES, ni con la contraseña correcta. */
export const LOCK_AFTER = 5;
export const LOCK_MINUTES = 15;
/** Los fallos se cuentan dentro de esta ventana: uno de hace una semana no suma con el de hoy. */
const WINDOW_MS = LOCK_MINUTES * 60_000;

type Id = string | mongoose.Types.ObjectId;
interface Lockable { lockedUntil?: Date | null; failedLogins?: number | null; lastFailedAt?: Date | null }

export const isLocked = (u: Lockable) => !!u.lockedUntil && u.lockedUntil.getTime() > Date.now();

/** Cuenta un intento fallido; al llegar al límite bloquea la cuenta y vuelve el contador a cero. */
export async function registerFailure(u: Lockable & { _id: Id }) {
  const now = new Date();
  const fresh = !u.lastFailedAt || now.getTime() - u.lastFailedAt.getTime() > WINDOW_MS;
  const after = await User.findOneAndUpdate(
    { _id: u._id },
    fresh ? { $set: { failedLogins: 1, lastFailedAt: now } } : { $inc: { failedLogins: 1 }, $set: { lastFailedAt: now } },
    { new: true }
  ).select('failedLogins').lean() as { failedLogins?: number } | null;
  if (after && (after.failedLogins ?? 0) >= LOCK_AFTER) {
    await User.updateOne({ _id: u._id }, { $set: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) }, $unset: { lastFailedAt: 1 } });
  }
}

/** Entró bien (o un administrador la desbloqueó): se borra todo rastro de fallos. */
export const clearFailures = (id: Id) => User.updateOne({ _id: id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1, lastFailedAt: 1 } });
