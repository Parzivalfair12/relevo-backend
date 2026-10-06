import { z } from 'zod';

/* ===== Constantes del dominio (idénticas al mockup) ===== */
export const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'] as const;
export const DIAS_SEMANA = ['D','L','M','M','J','V','S'] as const;

export const SHIFT_CODES = ['M','T','N','MT','L','V','I','P'] as const;
export type ShiftCode = (typeof SHIFT_CODES)[number];
export type Cell = ShiftCode | '';

export const SHIFT_NAME: Record<ShiftCode, string> = { M:'Mañana', T:'Tarde', N:'Noche', L:'Libre', MT:'Doble', V:'Vacaciones', I:'Incapacidad', P:'Permiso o licencia' };
export const SHIFT_DESC: Record<ShiftCode, string> = {
  M:'Mañana · 07:00–13:00 · 6 h', T:'Tarde · 13:00–19:00 · 6 h', N:'Noche · 19:00–07:00 · 12 h', L:'Libre',
  MT:'Doble · 07:00–19:00 · 12 h', V:'Vacaciones', I:'Incapacidad', P:'Permiso o licencia'
};
export const SERVICE_COLORS = ['#2BB3BD','#F29E6B','#7C8CE0','#6BC48F','#E88FB0','#F2C14E'] as const;
export const POSITIONS = ['Terapeuta respiratoria','Jefe de terapia respiratoria','Auxiliar'] as const;

/* ===== Esquemas Zod (los usan la API y la web) ===== */
export const roleSchema = z.enum(['admin','coord']);
export type Role = z.infer<typeof roleSchema>;
export const userStatusSchema = z.enum(['activo','pendiente']);
export const kindSchema = z.enum(['fija','apoyo']); // planta | apoyo
export type Kind = z.infer<typeof kindSchema>;
export const scheduleStatusSchema = z.enum(['bor','pub']); // borrador | publicado

export const coverageSchema = z.object({ M: z.number().int().min(0).max(10), T: z.number().int().min(0).max(10), N: z.number().int().min(0).max(10) });
export type Coverage = z.infer<typeof coverageSchema>;

export const rulesSchema = z.object({
  seq: z.boolean(), restAfterN: z.boolean(), weekends: z.boolean(), balance: z.boolean(),
  maxConsec: z.number().int().min(1).max(14), support: z.enum(['need','equal'])
});
export type Rules = z.infer<typeof rulesSchema>;
export const defaultRules = (): Rules => ({ seq: true, restAfterN: true, weekends: true, balance: true, maxConsec: 5, support: 'need' });
export const defaultCoverage = (): Coverage => ({ M: 1, T: 1, N: 1 });

export const MIN_PASSWORD = 8;
const email = z.string().trim().toLowerCase().email('Escribe un correo válido.');
const password = z.string().min(MIN_PASSWORD, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`).max(128);
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Identificador inválido');

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const registerSchema = z.object({ name: z.string().trim().min(1, 'Escribe tu nombre completo.').max(120), email, password });

export const serviceInputSchema = z.object({
  name: z.string().trim().min(3, 'Escribe el nombre del servicio.').max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() // si falta, el servidor elige el siguiente de la paleta
});
export const therapistInputSchema = z.object({
  name: z.string().trim().min(3, 'Escribe el nombre completo.').max(120),
  document: z.string().trim().max(20).default(''), // opcional, como en el mockup
  position: z.enum(POSITIONS),
  defaultKind: kindSchema,
  serviceIds: z.array(objectId).min(1, 'Elige al menos un servicio.'),
  active: z.boolean().default(true)
});
export const userInputSchema = z.object({
  name: z.string().trim().min(3, 'Escribe el nombre.').max(120),
  email, role: roleSchema, serviceIds: z.array(objectId)
}).refine(u => u.role === 'admin' || u.serviceIds.length > 0, { message: 'Asigna al menos un servicio.', path: ['serviceIds'] });
export const userCreateSchema = userInputSchema.and(z.object({ password }));
export const newScheduleSchema = z.object({ serviceId: objectId, year: z.number().int().min(2024).max(2100), month: z.number().int().min(0).max(11) });

/* ----- Cuadros: todas las escrituras llevan `version` (el __v que el cliente conoce); si no coincide, 409 ----- */
export const absenceCodeSchema = z.enum(['V', 'I', 'P']);
export const shiftCodeSchema = z.enum(SHIFT_CODES);
const version = z.number().int().min(0);
const dayNumber = z.number().int().min(1).max(31); // día 1 a n
export const cellChangeSchema = z.object({
  therapistId: objectId,
  day: z.number().int().min(0).max(30), // índice 0 a n−1
  code: shiftCodeSchema.nullable()      // null = quitar la fijación (el cuadro se recalcula)
});
export const cellsUpdateSchema = z.object({ version, changes: z.array(cellChangeSchema).min(1).max(2000) });
export const scheduleUpdateSchema = z.object({
  version,
  status: scheduleStatusSchema.optional(),
  coverage: coverageSchema.optional(),
  rules: rulesSchema.optional(),
  team: z.array(z.object({ therapistId: objectId, kind: kindSchema })).min(2, 'Se necesitan al menos 2 terapeutas').max(60).optional()
});
export const generateSchema = z.object({ version, variant: z.boolean().default(false) });
const absenceRange = z.object({ version, therapistId: objectId, from: dayNumber, to: dayNumber });
export const absenceInputSchema = absenceRange.extend({ code: absenceCodeSchema }).refine(a => a.to >= a.from, { message: 'El día final no puede ser anterior al inicial.', path: ['to'] });
export const absenceDeleteSchema = z.object({
  version: z.coerce.number().int().min(0), therapistId: objectId, from: z.coerce.number().int().min(1).max(31), to: z.coerce.number().int().min(1).max(31)
}).refine(a => a.to >= a.from, { message: 'El día final no puede ser anterior al inicial.', path: ['to'] });
export const scheduleListQuerySchema = z.object({ service: objectId.optional(), status: scheduleStatusSchema.optional() });

/* ----- Excel y ODS ----- */
export const exportQuerySchema = z.object({ format: z.enum(['xlsx', 'ods']).default('xlsx') });
export const importSchema = z.object({
  serviceId: objectId, year: z.number().int().min(2024).max(2100), month: z.number().int().min(0).max(11),
  /** Una entrada por persona que se importa; `cells` es el texto de cada día tal como viene en el archivo */
  members: z.array(z.object({ therapistId: objectId, cells: z.array(z.string().max(40)).max(31) })).min(2, 'Se necesitan al menos 2 terapeutas').max(60)
});
export const importPreviewQuerySchema = z.object({ serviceId: objectId });

/* ----- Resumen: el período va como YYYY-MM (mes 01 a 12, formato de URL; en el código los meses siguen siendo 0 a 11) ----- */
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El período debe ser AAAA-MM (por ejemplo 2026-09).');
export const dashboardQuerySchema = z.object({ service: objectId.optional(), from: yearMonth.optional(), to: yearMonth.optional() })
  .refine(q => !q.from || !q.to || q.from <= q.to, { message: 'El período inicial no puede ser posterior al final.', path: ['to'] });

/* ===== Tipos de respuesta de la API ===== */
export interface UserDTO { id: string; name: string; email: string; role: Role; status: 'activo'|'pendiente'; serviceIds: string[] }
/** scheduleCount y therapistCount solo los usa la pantalla de Administración */
export interface ServiceDTO { id: string; name: string; color: string; scheduleCount?: number; therapistCount?: number }
export interface TherapistDTO { id: string; name: string; document: string; position: string; defaultKind: Kind; serviceIds: string[]; active: boolean; scheduleCount: number }
export interface ScheduleMemberDTO { therapistId: string; name: string; kind: Kind; days: Cell[]; locked: Record<number, ShiftCode> }
export interface ScheduleDTO {
  id: string; serviceId: string; year: number; month: number; status: 'bor'|'pub'; ownerId: string; ownerName: string;
  coverage: Coverage; rules: Rules; seed: number; members: ScheduleMemberDTO[]; version: number;
  updatedByName?: string;
  /** Últimas casillas del mes anterior del mismo servicio, por terapeuta: el editor las usa para validar la continuidad */
  prev: Record<string, Cell[]>;
  /** Días (índice 0 a n−1) en que la terapeuta ya trabaja en OTRO cuadro del mismo mes: terapeuta → día → nombre del servicio */
  busy: Record<string, Record<number, string>>;
}
/** Tarjeta de la lista de cuadros */
export interface ScheduleSummaryDTO {
  id: string; serviceId: string; year: number; month: number; status: 'bor'|'pub'; ownerId: string; ownerName: string;
  days: number; totalHours: number; neededHours: number; planta: number; apoyo: number; criticalAlerts: number
}
/** Cuerpo de un 409 por versión: quién hizo el último cambio y la versión actual */
export interface VersionConflictDetails { updatedByName?: string; version: number }
/* ----- Importar un cuadro ----- */
export interface ImportPersonDTO {
  name: string; row: number;
  cells: string[];            // texto de cada día, tal como viene en el archivo
  codes: Cell[];              // cómo se leyó cada día (lo que no se entendió queda libre)
  warnings: string[];
  matchId: string | null;     // terapeuta del directorio que coincide, si hay una sola
  suggestions: { id: string; name: string }[]
}
export interface ImportTableDTO { id: string; sheet: string; headerRow: number; title: string; year: number | null; month: number | null; days: number; people: ImportPersonDTO[] }
export interface ImportPreviewDTO { tables: ImportTableDTO[] }
export interface ImportResultDTO { schedule: ScheduleDTO; warnings: string[] }

/* ----- Resumen ----- */
/** Un día del patrón: el código del turno o 'x' si ese día no hay cuadro. */
export type PatternCell = ShiftCode | 'x';
export interface DashboardInsight { tone: 'w' | 'o' | 'i'; icon: string; title: string; text: string }
export interface DashboardTherapistRow {
  id: string; name: string; serviceIds: string[]; kinds: Kind[];
  hours: number; M: number; T: number; N: number;       // M y T cuentan también los dobles (MT)
  weekendDays: number; workDays: number; days: number; absDays: number;
  everyDays: number;  // «trabaja cada»: días del período / días trabajados
  restAvg: number;    // descanso medio entre bloques de trabajo, en días
  maxRun: number;     // racha máxima de días seguidos
  pattern: PatternCell[]
}
export interface DashboardDTO {
  from: string; to: string; scheduleCount: number;
  kpis: { hours: number; activeTherapists: number; idleTherapists: number; coveragePct: number; gapDays: number; totalDays: number; supportHours: number; supportPct: number; absenceDays: number };
  insights: DashboardInsight[];
  therapists: DashboardTherapistRow[];
  hoursByMonth: { year: number; month: number; M: number; T: number; N: number; total: number }[];
  hoursByService: { serviceId: string; hours: number }[];
}
export interface DashboardTherapistDetail extends DashboardTherapistRow { months: { year: number; month: number; hours: number; days: PatternCell[] }[] }

export interface ApiError { code: string; message: string; details?: unknown }
