import { HRS, daysIn, isWeekend, type Cell } from '../engine/index.js';
import { DIAS_SEMANA, MESES } from '../shared/index.js';

/**
 * Diseño neutro del cuadro en el formato del hospital (hoja SERV-PISO de su cuadro real):
 * título, centro de costos y «CIUDAD, MES AÑO»; fila FECHA con los días y fila DÍAS con la letra del día;
 * por persona dos filas (turnos y horas por día, con la suma en HORAS); fines de semana en amarillo y
 * ausencias en naranja; al final la leyenda de turnos. Los escritores de Excel y de ODS solo traducen este diseño.
 */
export type Edge = 'thin' | 'thick' | undefined;
export interface Style {
  bold?: boolean; size?: number; fill?: string; align?: 'left' | 'center'; valign?: 'middle';
  border?: { t?: Edge; b?: Edge; l?: Edge; r?: Edge }
}
export interface LCell { v?: string | number; /** fórmula en notación A1, sin «=» */ f?: string; style: Style }
export interface Merge { r1: number; c1: number; r2: number; c2: number }
export interface Layout {
  sheetName: string; nRows: number; nCols: number;
  colWidths: number[];                // en caracteres
  rowHeights: Record<number, number>; // en puntos (las filas sin dato usan la altura normal)
  cells: Map<string, LCell>;          // clave «fila,columna» (desde 0)
  merges: Merge[]
}

export const COLORS = { gray: 'C0C0C0', yellow: 'FDE9A9', orange: 'FC5C00', ink: '000000' } as const;
export const colName = (c: number) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export const cellKey = (r: number, c: number) => `${r},${c}`;

export interface ExportInput { serviceName: string; year: number; month: number; city: string; members: { name: string; kind: 'fija' | 'apoyo'; days: Cell[] }[] }

const thin = 'thin' as const, thick = 'thick' as const;
const isOff = (c: string) => c === 'V' || c === 'I' || c === 'P';

export function buildLayout(input: ExportInput): Layout {
  const { year, month } = input, n = daysIn(year, month);
  const firstDay = 2, lastDay = 1 + n, hoursCol = 2 + n;
  const L: Layout = { sheetName: `${MESES[month]} ${year}`, nRows: 0, nCols: hoursCol + 1, colWidths: [4.5, 34, ...Array(n).fill(4.4), 9], rowHeights: {}, cells: new Map(), merges: [] };
  const put = (r: number, c: number, style: Style, v?: string | number, f?: string) => { L.cells.set(cellKey(r, c), { v, f, style }); L.nRows = Math.max(L.nRows, r + 1); };
  const merge = (r1: number, c1: number, r2: number, c2: number) => L.merges.push({ r1, c1, r2, c2 });
  const upper = (s: string) => s.toUpperCase();

  // Encabezado: título, centro de costos y ciudad/mes (combinados a lo ancho de los días)
  const head: Style = { bold: true, size: 12, align: 'left', valign: 'middle' };
  [[1, `PROFESIONALES  ${upper(input.serviceName)}`], [2, `CENTRO DE COSTOS: ${upper(input.serviceName)}`], [3, `${upper(input.city)}, ${upper(MESES[month])} ${year}`]].forEach(([r, text]) => {
    put(r as number, 1, head, text as string); merge(r as number, 1, r as number, lastDay); L.rowHeights[r as number] = 19;
  });

  // Filas FECHA y DÍAS
  const R_DATE = 5, R_DOW = 6;
  put(R_DATE, 0, { fill: COLORS.gray, border: { t: thick, b: thin, l: thick, r: thick } }); put(R_DOW, 0, { fill: COLORS.gray, border: { t: thin, b: thick, l: thick, r: thick } });
  merge(R_DATE, 0, R_DOW, 0);
  put(R_DATE, 1, { bold: true, size: 10, fill: COLORS.gray, align: 'left', valign: 'middle', border: { t: thick, b: thin, l: thick } }, 'FECHA');
  put(R_DOW, 1, { bold: true, size: 10, fill: COLORS.gray, align: 'left', valign: 'middle', border: { t: thin, b: thick, l: thick } }, 'DÍAS');
  for (let d = 1; d <= n; d++) {
    put(R_DATE, 1 + d, { bold: true, size: 10, fill: COLORS.yellow, align: 'center', valign: 'middle', border: { t: thick, b: thin, l: thin, r: d === n ? thick : thin } }, d);
    put(R_DOW, 1 + d, { bold: true, size: 10, fill: COLORS.yellow, align: 'center', valign: 'middle', border: { t: thin, b: thick, l: thin, r: d === n ? thick : thin } }, DIAS_SEMANA[new Date(year, month, d).getDay()]);
  }
  put(R_DATE, hoursCol, { bold: true, size: 10, fill: COLORS.gray, align: 'center', valign: 'middle', border: { t: thick, b: thick, l: thick, r: thick } }, 'HORAS');
  put(R_DOW, hoursCol, { fill: COLORS.gray, border: { t: thick, b: thick, l: thick, r: thick } });
  merge(R_DATE, hoursCol, R_DOW, hoursCol);

  // Personas: planta primero, luego apoyo; dos filas por persona
  const ordered = input.members.filter(m => m.kind === 'fija').concat(input.members.filter(m => m.kind === 'apoyo'));
  let r = 7;
  ordered.forEach((m, i) => {
    const r2 = r + 1, hrs = m.days.map(c => HRS[c] || 0), total = hrs.reduce((a, b) => a + b, 0);
    put(r, 0, { bold: true, size: 10, align: 'center', valign: 'middle', border: { t: thin, b: thin, l: thick, r: thick } }, i + 1);
    put(r2, 0, { border: { t: thin, b: thin, l: thick, r: thick } }); merge(r, 0, r2, 0);
    put(r, 1, { bold: true, size: 10, align: 'left', valign: 'middle', border: { t: thick, b: thin, l: thick, r: thick } }, m.name.toUpperCase());
    put(r2, 1, { size: 10, border: { t: thin, b: thick, l: thick, r: thick } });
    for (let d = 1; d <= n; d++) {
      const code = m.days[d - 1] ?? 'L';
      const fill = isOff(code) ? COLORS.orange : isWeekend(year, month, d) ? COLORS.yellow : undefined;
      const right = d === n ? thick : thin;
      put(r, 1 + d, { size: 10, align: 'center', valign: 'middle', fill, border: { t: thick, b: thin, l: thin, r: right } }, code);
      put(r2, 1 + d, { size: 10, align: 'center', valign: 'middle', fill, border: { t: thin, b: thick, l: thin, r: right } }, hrs[d - 1] || undefined);
    }
    put(r, hoursCol, { border: { t: thick, b: thin, l: thin, r: thick } });
    put(r2, hoursCol, { bold: true, size: 10, align: 'center', valign: 'middle', border: { t: thin, b: thick, l: thin, r: thick } }, total, `SUM(${colName(firstDay)}${r2 + 1}:${colName(lastDay)}${r2 + 1})`);
    L.rowHeights[r] = 18; L.rowHeights[r2] = 18;
    r += 2;
  });

  // Leyenda (como «TURNOS» del cuadro del hospital, más las claves que usa la aplicación)
  r += 1;
  const legend: [string, boolean][] = [['TURNOS', true], ['MAÑANA : 07:00 - 13:00', false], ['TARDE : 13:00 - 19:00', false], ['NOCHE : 19:00 - 07:00', false],
    ['MT = DOBLE : 07:00 - 19:00', false], ['L = LIBRE', false], ['V = VACACIONES', false], ['I = INCAPACIDAD', false], ['P = PERMISO O LICENCIA', false]];
  for (const [text, bold] of legend) { put(r++, 1, { bold, size: 10, align: 'left' }, text); }
  return L;
}
