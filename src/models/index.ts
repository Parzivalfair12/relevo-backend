import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { SHIFT_CODES } from '../shared/index.js';

const oid = Schema.Types.ObjectId;

/* users: correo único, hash argon2id (nunca se devuelve en la API) */
const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'coord'], default: 'coord' },
  status: { type: String, enum: ['activo', 'pendiente'], default: 'pendiente' },
  serviceIds: [{ type: oid, ref: 'Service' }],
  // Tokens de renovación vigentes (hash del jti). Rotan en cada uso; uno desconocido revoca todos.
  refreshTokens: { type: [{ _id: false, jti: String, exp: Date }], select: false, default: [] }
}, { timestamps: true });

/* services: UCI Neurocrítica, Hospitalización... */
const serviceSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  color: { type: String, required: true },
  defaultCoverage: { M: { type: Number, default: 1 }, T: { type: Number, default: 1 }, N: { type: Number, default: 1 } },
  defaultRules: { type: Schema.Types.Mixed }
}, { timestamps: true });

/* therapists: directorio. Nunca se borra si aparece en un cuadro: se desactiva. */
const therapistSchema = new Schema({
  name: { type: String, required: true, trim: true, index: 'text' },
  document: { type: String, trim: true }, // opcional; único solo si existe (índice parcial abajo)
  position: { type: String, required: true },
  defaultKind: { type: String, enum: ['fija', 'apoyo'], default: 'fija' },
  serviceIds: [{ type: oid, ref: 'Service' }],
  active: { type: Boolean, default: true }
}, { timestamps: true });

therapistSchema.index({ document: 1 }, { unique: true, partialFilterExpression: { document: { $type: 'string' } } });

/* schedules: un cuadro por servicio y mes. Los turnos viven dentro (members[].days). */
const memberSchema = new Schema({
  therapistId: { type: oid, ref: 'Therapist', required: true },
  kind: { type: String, enum: ['fija', 'apoyo'], required: true }, // planta o apoyo EN ESTE cuadro
  days: [{ type: String, enum: ['', ...SHIFT_CODES] }],
  locked: [{ _id: false, day: Number, code: { type: String, enum: SHIFT_CODES } }] // casillas fijadas a mano (day: 0 a n-1)
}, { _id: false });

const scheduleSchema = new Schema({
  serviceId: { type: oid, ref: 'Service', required: true },
  year: { type: Number, required: true },
  month: { type: Number, required: true, min: 0, max: 11 },
  status: { type: String, enum: ['bor', 'pub'], default: 'bor' },
  ownerId: { type: oid, ref: 'User', required: true },
  updatedBy: { type: oid, ref: 'User' }, // quién hizo el último cambio (se muestra en un conflicto de versión)
  coverage: { M: Number, T: Number, N: Number },
  rules: { type: Schema.Types.Mixed },
  seed: { type: Number, default: 1 },
  members: [memberSchema],
  stats: { type: Schema.Types.Mixed } // se recalcula al guardar
}, { timestamps: true }); // versionKey __v = control de versiones (409 en conflicto)
scheduleSchema.index({ serviceId: 1, year: 1, month: 1 }, { unique: true });
scheduleSchema.index({ status: 1, year: 1, month: 1 });

const auditSchema = new Schema({
  userId: { type: oid, ref: 'User' },
  action: String, entity: String, entityId: oid, summary: String,
  createdAt: { type: Date, default: Date.now }
});
auditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = mongoose.models.User || mongoose.model('User', userSchema);
export const Service = mongoose.models.Service || mongoose.model('Service', serviceSchema);
export const Therapist = mongoose.models.Therapist || mongoose.model('Therapist', therapistSchema);
export const Schedule = mongoose.models.Schedule || mongoose.model('Schedule', scheduleSchema);
export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditSchema);
