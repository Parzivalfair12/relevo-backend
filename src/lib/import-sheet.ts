import * as XLSX from 'xlsx';
import type { Cell, Code } from '../engine/index.js';
import { MESES } from '../shared/index.js';

/**
 * Lectura de un cuadro de turnos en Excel u ODS con el formato del hospital. Reconoce, en cualquier hoja:
 *   · una fila «FECHA(S)» seguida de los días 1, 2, 3… (de ahí salen la columna de nombres y la de cada día);
 *   · debajo, dos filas por persona: una con los turnos y otra con las horas; el nombre puede estar en cualquiera de las dos;
 *   · el mes y el año en el encabezado («NEIVA, SEPTIEMBRE 2026») o, si no, en el nombre de la hoja («MAYO_2025»).
 * Las ausencias que el hospital escribe letra por letra en días seguidos («PE R MI S O») se juntan en una sola.
 */
/** hours: total de la columna HORAS del archivo (informativo: sirve de meta inicial), null si no la trae */
export interface ParsedPerson { name: string; row: number; cells: string[]; hours: number | null }
export interface ParsedTable { id: string; sheet: string; headerRow: number; title: string; year: number | null; month: number | null; days: number; people: ParsedPerson[] }

const MAX_BYTES = 8 * 1024 * 1024, MAX_ROWS = 1200, MAX_PEOPLE = 80;
export const MAX_FILE_BYTES = MAX_BYTES;

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const letters = (s: string) => strip(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const STOP = ['TOTAL', 'CONVENCIONES', 'HORARIOS', 'TURNOS', 'OBSERVACIONES', 'FIRMA', 'ELABORO', 'COORDINADORA', 'COORDINADOR', 'FECHA'];

function monthYear(s: string): { month: number; year: number } | null {
  const t = strip(s).toLowerCase().replace(/setiembre/, 'septiembre');
  const names = MESES.map(m => m.toLowerCase());
  const m = new RegExp(`(${names.join('|')})\\D{0,6}(20\\d\\d)`).exec(t);
  return m ? { month: names.indexOf(m[1]), year: Number(m[2]) } : null;
}

export class ImportError extends Error {}

const MAX_UNZIPPED = 100 * 1024 * 1024, MAX_ENTRIES = 2000;
/**
 * .xlsx y .ods son zips. Un zip «bomba» pesa poco comprimido y ocupa gigas al abrirlo: antes de dárselo a SheetJS se
 * suma el tamaño descomprimido que declara el directorio central y se rechaza si es desproporcionado.
 */
export function assertSafeZip(buf: Buffer) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return; // no es un zip (p. ej. .xls o texto): lo trata el lector
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ImportError('El archivo está dañado.');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  if (entries > MAX_ENTRIES) throw new ImportError('El archivo tiene demasiadas partes para ser un cuadro.');
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ImportError('El archivo está dañado.');
    total += buf.readUInt32LE(p + 24);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  if (total > MAX_UNZIPPED) throw new ImportError('El archivo es demasiado grande al abrirlo.');
}

export function parseWorkbook(buf: Buffer): ParsedTable[] {
  if (buf.length === 0) throw new ImportError('El archivo está vacío.');
  if (buf.length > MAX_BYTES) throw new ImportError('El archivo pesa más de 8 MB.');
  assertSafeZip(buf);
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buf, { type: 'buffer', sheetRows: MAX_ROWS, cellFormula: false, cellHTML: false, cellStyles: false }); }
  catch { throw new ImportError('No se pudo leer el archivo. Sube un cuadro en formato .xlsx o .ods.'); }

  const tables: ParsedTable[] = [];
  for (const sheet of wb.SheetNames) {
    const ws = wb.Sheets[sheet];
    if (!ws?.['!ref']) continue;
    // Se parte de A1 para que los índices de fila y columna sean los reales de la hoja
    const range = XLSX.utils.decode_range(ws['!ref']);
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: range.e });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '', blankrows: true });
    const sheetDate = monthYear(sheet.replace(/_/g, ' '));
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (!['FECHA', 'FECHAS'].includes(letters(text(rows[r][c])))) continue;
        let days = 0;
        while (Number(rows[r][c + 1 + days]) === days + 1 && text(rows[r][c + 1 + days]) !== '') days++;
        if (days < 28 || days > 31) continue;
        tables.push(readTable(rows, sheet, r, c, days, sheetDate, tables.length));
        break;
      }
    }
  }
  // Se descartan las plantillas: tablas sin una sola casilla escrita
  return tables.filter(t => t.people.some(p => p.cells.some(c => c !== '')));
}

function readTable(rows: unknown[][], sheet: string, hr: number, nameCol: number, days: number, sheetDate: { month: number; year: number } | null, idx: number): ParsedTable {
  // Encabezado: las líneas de texto justo encima de la fila FECHA
  const above: string[] = [];
  for (let r = hr - 1; r >= Math.max(0, hr - 8); r--) for (const v of rows[r] ?? []) { const t = text(v); if (t && !above.includes(t) && !/^\d+$/.test(t)) above.push(t); }
  const date = above.map(monthYear).find(Boolean) ?? sheetDate;
  const title = above.slice(0, 3).reverse().join(' · ') || sheet;

  // Columna «HORAS» de la fila de encabezado, si existe
  const hoursCol = (rows[hr] ?? []).findIndex((v, i) => i > nameCol && letters(text(v)) === 'HORAS');
  const hoursOf = (row: unknown[]): number | null => { const v = hoursCol >= 0 ? Number(row?.[hoursCol]) : NaN; return Number.isFinite(v) && text(row?.[hoursCol]) !== '' ? v : null; };
  const dayCells = (row: unknown[]) => Array.from({ length: days }, (_, i) => row?.[nameCol + 1 + i]);
  const people: ParsedPerson[] = [];
  const hasText = (row: unknown[]) => dayCells(row).some(v => text(v) !== '' && typeof v !== 'number');
  for (let r = hr + 2; r < rows.length && people.length < MAX_PEOPLE; r += 2) {
    const a = rows[r] ?? [], b = rows[r + 1] ?? [];
    const nameA = text(a[nameCol]), nameB = text(b[nameCol]);
    const name = nameA || nameB;
    if (!name && !hasText(a) && !hasText(b)) break;           // dos filas vacías: terminó la tabla
    if (STOP.some(s => letters(name).startsWith(s))) break;    // «TOTAL DE HORAS», «CONVENCIONES», otra tabla…
    if (!name) { r -= 1; continue; }                           // fila suelta sin nombre: se salta una y se reintenta
    const codesRow = hasText(a) ? a : hasText(b) ? b : a;
    const other = codesRow === a ? b : a;
    people.push({ name: name.replace(/\s+/g, ' '), row: r + 1, cells: dayCells(codesRow).map(v => (typeof v === 'number' ? String(v) : text(v))), hours: hoursOf(other) ?? hoursOf(codesRow) });
  }
  return { id: `${idx}`, sheet, headerRow: hr + 1, title, year: date?.year ?? null, month: date?.month ?? null, days, people };
}

/* ====================== Casillas: texto del archivo → código del turno ====================== */
const CODES: Record<string, Code> = { M: 'M', T: 'T', N: 'N', MT: 'MT', L: 'L', V: 'V', I: 'I', P: 'P' };
/** Palabras que el hospital escribe para las ausencias (también cuando las parte en letras sueltas por día). */
const WORDS: [string, Code][] = [
  ['VACACIONES', 'V'], ['INCAPACIDAD', 'I'], ['PERMISO', 'P'], ['LICENCIA', 'P'], ['ESTUDIO', 'P'], ['CALAMIDAD', 'P'], ['COMPENSATORIO', 'P'], ['DESCANSO', 'L']
];
const wordCode = (w: string): Code | null => (w.length >= 3 ? WORDS.find(([k]) => k.startsWith(w) || w.startsWith(k))?.[1] ?? null : null);

export interface NormalizedRow { codes: Cell[]; locked: Record<number, Code>; warnings: string[] }

/**
 * Convierte una fila de texto del archivo en un código por día. Vacío = libre.
 * Todo turno o ausencia reconocido queda fijado (viene de lo que hizo el hospital a mano); lo que no se entiende
 * queda libre y se avisa con su posición.
 */
export function normalizeCells(raw: string[], days: number): NormalizedRow {
  const codes: Cell[] = Array(days).fill('L'), locked: Record<number, Code> = {}, warnings: string[] = [];
  const tok = (i: number) => letters(raw[i] ?? '');
  for (let i = 0; i < days; i++) {
    const t = tok(i);
    if (t === '') continue;
    if (CODES[t]) { codes[i] = CODES[t]; if (CODES[t] !== 'L') locked[i] = CODES[t]; continue; }
    // Un tramo de casillas con letras sueltas (PE · R · MI · S · O) se lee como una sola palabra
    let j = i, word = '';
    while (j < days && tok(j) !== '' && !CODES[tok(j)] && /^[A-Z]+$/.test(tok(j))) word += tok(j++);
    const code = wordCode(word);
    if (code && j > i) { for (let k = i; k < j; k++) { codes[k] = code; if (code !== 'L') locked[k] = code; } i = j - 1; continue; }
    warnings.push(`Día ${i + 1}: «${(raw[i] ?? '').trim()}» no se reconoce; quedó libre.`);
  }
  return { codes, locked, warnings };
}

/* ====================== Nombres del archivo → terapeutas del directorio ====================== */
const nameTokens = (s: string) => strip(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

export interface Candidate { id: string; name: string }
/**
 * Coincidencia exacta (sin tildes ni mayúsculas) o, si el nombre del archivo es más corto («MERCEDES BECERRA»),
 * única terapeuta que contiene todas sus palabras (mínimo dos). Si hay más de una, no se adivina: se dan sugerencias.
 */
export function matchName(name: string, pool: Candidate[]): { matchId: string | null; suggestions: Candidate[] } {
  const want = nameTokens(name), key = want.join(' ');
  const exact = pool.filter(c => nameTokens(c.name).join(' ') === key);
  if (exact.length === 1) return { matchId: exact[0].id, suggestions: [] };
  const scored = pool.map(c => { const t = nameTokens(c.name); return { c, shared: want.filter(w => t.includes(w)).length, all: want.length >= 2 && want.every(w => t.includes(w)) }; });
  const contained = scored.filter(s => s.all);
  if (exact.length === 0 && contained.length === 1) return { matchId: contained[0].c.id, suggestions: [] };
  return { matchId: null, suggestions: scored.filter(s => s.shared >= 1).sort((a, b) => b.shared - a.shared).slice(0, 3).map(s => s.c) };
}
