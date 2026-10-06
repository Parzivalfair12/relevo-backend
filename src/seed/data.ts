/**
 * Datos de ejemplo IDÉNTICOS a los del mockup (referencia/mockup-referencia.html).
 * Puro y sin base de datos: se prueba solo y lo usa `npm run seed`.
 * Las claves (u1, s1, ...) son ids de ejemplo; el seed las traduce a ObjectId.
 */
import { generate, daysIn, type Config, type Person, type Locked, type Grid, type Code, type Cell } from '../engine/index.js';
import { SERVICE_COLORS, POSITIONS, defaultRules, type Kind } from '../shared/index.js';

export const SEED_USERS = [
  { key: 'a1', name: 'Administrador Demo', email: 'admin@turnos.demo', password: 'admin123', role: 'admin' as const, serviceKeys: [] as string[] },
  { key: 'c1', name: 'Coordinadora Demo', email: 'coordinadora@turnos.demo', password: 'coord123', role: 'coord' as const, serviceKeys: ['s1', 's2'] },
  { key: 'c2', name: 'Coordinador Urgencias', email: 'urgencias@turnos.demo', password: 'urg123', role: 'coord' as const, serviceKeys: ['s3'] }
];

export const SEED_SERVICES = [
  { key: 's1', name: 'UCI Neurocrítica', color: SERVICE_COLORS[0] },
  { key: 's2', name: 'Hospitalización 7° piso', color: SERVICE_COLORS[1] },
  { key: 's3', name: 'Urgencias', color: SERVICE_COLORS[2] }
];

const P: [string, string, Kind, string][] = [
  ['u1','Carolina Sánchez','fija','s1'],['u2','María Mercedes Becerra','fija','s1'],['u3','Mayra Cerquera','fija','s1'],['u4','Jessica Romero','fija','s1'],
  ['u5','Sandra Ríos','apoyo','s1'],['u6','Gloria Oquendo','apoyo','s1'],['u7','Maidy Trujillo','apoyo','s1'],
  ['h1','Laura Gómez','fija','s2'],['h2','Andrea Pérez','fija','s2'],['h3','Diana Muñoz','fija','s2'],['h4','Camila Torres','fija','s2'],
  ['h5','Natalia Rojas','apoyo','s2'],['h6','Paola Castro','apoyo','s2'],
  ['g1','Viviana Mora','fija','s3'],['g2','Daniela Cruz','fija','s3'],['g3','Juliana Ortiz','fija','s3'],['g4','Sebastián Vargas','fija','s3'],['g5','Ángela Ruiz','apoyo','s3']
];
export const SEED_THERAPISTS = P.map(([key, name, defaultKind, svc], i) => ({
  key, name, document: String(1075000000 + i * 7919), position: POSITIONS[0] as string, defaultKind, serviceKeys: [svc], active: true
}));

const nameOf = (key: string) => SEED_THERAPISTS.find(t => t.key === key)!.name;
const UCI: [string, Kind][] = [['u1','fija'],['u2','fija'],['u3','fija'],['u4','fija'],['u5','apoyo'],['u6','apoyo'],['u7','apoyo']];
const HOS: [string, Kind][] = [['h1','fija'],['h2','fija'],['h3','fija'],['h4','fija'],['h5','apoyo'],['h6','apoyo']];
const URG: [string, Kind][] = [['g1','fija'],['g2','fija'],['g3','fija'],['g4','fija'],['g5','apoyo']];
const rng2 = (id: string, a: number, b: number, code: Code): Locked => { const o: Record<number, Code> = {}; for (let d = a; d <= b; d++) o[d] = code; return { [id]: o }; };
const mrg = (...xs: Locked[]): Locked => Object.assign({}, ...xs);

interface SeedScheduleDef { serviceKey: string; year: number; month: number; ownerKey: string; status: 'bor' | 'pub'; seed: number; team: [string, Kind][]; locked: Locked }
/** Orden importa: cada mes continúa la secuencia del anterior (igual que el mockup). */
export const SEED_SCHEDULE_DEFS: SeedScheduleDef[] = [
  { serviceKey: 's1', year: 2026, month: 6, ownerKey: 'c1', status: 'pub', seed: 5, team: UCI, locked: mrg(rng2('u2', 12, 14, 'I'), rng2('u5', 0, 9, 'V')) },
  { serviceKey: 's1', year: 2026, month: 7, ownerKey: 'c1', status: 'pub', seed: 9, team: UCI, locked: mrg(rng2('u1', 3, 4, 'P'), rng2('u4', 20, 24, 'I')) },
  { serviceKey: 's1', year: 2026, month: 8, ownerKey: 'c1', status: 'bor', seed: 3, team: UCI, locked: mrg(rng2('u3', 9, 11, 'I'), rng2('u4', 17, 18, 'P'), rng2('u1', 20, 26, 'V')) },
  { serviceKey: 's2', year: 2026, month: 6, ownerKey: 'c1', status: 'pub', seed: 4, team: HOS, locked: rng2('h2', 10, 16, 'V') },
  { serviceKey: 's2', year: 2026, month: 7, ownerKey: 'c1', status: 'pub', seed: 6, team: HOS, locked: rng2('h3', 2, 4, 'I') },
  { serviceKey: 's2', year: 2026, month: 8, ownerKey: 'c1', status: 'bor', seed: 8, team: HOS, locked: mrg(rng2('h1', 8, 8, 'P'), rng2('h4', 22, 28, 'V')) },
  { serviceKey: 's3', year: 2026, month: 6, ownerKey: 'c2', status: 'pub', seed: 2, team: URG, locked: rng2('g2', 0, 6, 'V') },
  { serviceKey: 's3', year: 2026, month: 7, ownerKey: 'c2', status: 'pub', seed: 7, team: URG, locked: rng2('g3', 15, 19, 'I') }
];

export interface BuiltSchedule extends Omit<SeedScheduleDef, 'team'> {
  coverage: { M: number; T: number; N: number };
  rules: ReturnType<typeof defaultRules>;
  members: { therapistKey: string; kind: Kind; days: Cell[]; locked: { day: number; code: Code }[] }[];
}

/** Genera los cuadros con el motor, continuando la secuencia del mes anterior del mismo servicio. */
export function buildSeedSchedules(): BuiltSchedule[] {
  const built: BuiltSchedule[] = [];
  const grids: Record<string, Grid> = {};
  for (const def of SEED_SCHEDULE_DEFS) {
    const staff: Person[] = def.team.map(([id, kind]) => ({ id, name: nameOf(id), kind }));
    const pm: [number, number] = def.month === 0 ? [def.year - 1, 11] : [def.year, def.month - 1];
    const prevGrid = grids[`${def.serviceKey}-${pm[0]}-${pm[1]}`];
    const prev: Record<string, Cell[]> = {};
    if (prevGrid) staff.forEach(p => { if (prevGrid[p.id]) prev[p.id] = prevGrid[p.id].slice(-7); });
    const rules = defaultRules(), coverage = { M: 1, T: 1, N: 1 };
    const cfg: Config = { year: def.year, month: def.month, staff, cov: coverage, rules, locked: def.locked, seed: def.seed, prev };
    const grid = generate(cfg);
    grids[`${def.serviceKey}-${def.year}-${def.month}`] = grid;
    const { team, ...rest } = def;
    built.push({
      ...rest, coverage, rules,
      members: team.map(([id, kind]) => ({
        therapistKey: id, kind, days: grid[id],
        locked: Object.entries(def.locked[id] || {}).map(([d, code]) => ({ day: Number(d), code }))
      }))
    });
  }
  return built;
}
export { daysIn };
