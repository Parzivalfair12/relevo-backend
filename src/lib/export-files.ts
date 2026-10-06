import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { cellKey, type Edge, type Layout, type LCell, type Style } from './sheet-layout.js';

/* ====================== Excel (.xlsx) con ExcelJS ====================== */
const xlEdge = (e: Edge): Partial<ExcelJS.Border> | undefined => (e ? { style: e === 'thick' ? 'medium' : 'thin', color: { argb: 'FF000000' } } : undefined);

export async function toXlsx(layout: Layout): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Relevo'; wb.created = new Date();
  const ws = wb.addWorksheet(layout.sheetName, {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 5 }, // oficio, ajustado al ancho
    views: [{ showGridLines: false }]
  });
  layout.colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const [r, h] of Object.entries(layout.rowHeights)) ws.getRow(Number(r) + 1).height = h;
  for (const m of layout.merges) ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);
  for (const [key, cell] of layout.cells) {
    const [r, c] = key.split(',').map(Number), x = ws.getCell(r + 1, c + 1), s = cell.style;
    if (cell.f) x.value = { formula: cell.f, result: cell.v as number }; else if (cell.v !== undefined) x.value = cell.v;
    x.font = { name: 'Arial', size: s.size ?? 10, bold: !!s.bold };
    if (s.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + s.fill } };
    x.alignment = { horizontal: s.align ?? 'center', vertical: s.valign ?? 'middle' };
    if (s.border) x.border = { top: xlEdge(s.border.t), bottom: xlEdge(s.border.b), left: xlEdge(s.border.l), right: xlEdge(s.border.r) };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ====================== ODS (OpenDocument) escrito a mano ====================== */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cm = (pt: number) => (pt / 28.3465).toFixed(3) + 'cm';
const charsToCm = (chars: number) => ((chars * 7 + 5) / 96 * 2.54).toFixed(3) + 'cm'; // ancho de columna de Excel (píxeles a 96 ppp)
const odEdge = (e: Edge) => (e ? (e === 'thick' ? '2pt solid #000000' : '0.5pt solid #000000') : 'none');

function cellStyleXml(name: string, s: Style): string {
  const b = s.border ?? {};
  const props = `fo:border-top="${odEdge(b.t)}" fo:border-bottom="${odEdge(b.b)}" fo:border-left="${odEdge(b.l)}" fo:border-right="${odEdge(b.r)}" style:vertical-align="${s.valign ?? 'middle'}" fo:background-color="${s.fill ? '#' + s.fill : 'transparent'}"`;
  return `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties ${props}/>` +
    `<style:paragraph-properties fo:text-align="${s.align === 'left' ? 'start' : 'center'}"/>` +
    `<style:text-properties style:font-name="Arial" fo:font-size="${s.size ?? 10}pt" fo:font-weight="${s.bold ? 'bold' : 'normal'}"/></style:style>`;
}

/** Las fórmulas del diseño son sumas de un rango (SUM(C9:AF9)); en ODS se escriben `of:=SUM([.C9:.AF9])`. */
function odsFormula(f: string): string {
  const m = /^SUM\(([A-Z]+\d+):([A-Z]+\d+)\)$/.exec(f);
  if (!m) throw new Error(`Fórmula no soportada: ${f}`);
  return `of:=SUM([.${m[1]}:.${m[2]}])`;
}

export async function toOds(layout: Layout): Promise<Buffer> {
  // Estilos únicos de celda, de columna y de fila
  const styleIds = new Map<string, string>(), styleXml: string[] = [];
  const styleFor = (s: Style) => { const k = JSON.stringify(s); let id = styleIds.get(k); if (!id) { id = `ce${styleIds.size + 1}`; styleIds.set(k, id); styleXml.push(cellStyleXml(id, s)); } return id; };
  const blank: Style = {};
  const colIds = layout.colWidths.map((w, i) => ({ id: `co${i + 1}`, xml: `<style:style style:name="co${i + 1}" style:family="table-column"><style:table-column-properties style:column-width="${charsToCm(w)}"/></style:style>` }));
  const rowIds = new Map<number, string>(), rowXml: string[] = [];
  for (const h of new Set(Object.values(layout.rowHeights))) { rowIds.set(h, `ro${rowIds.size + 1}`); rowXml.push(`<style:style style:name="ro${rowIds.size}" style:family="table-row"><style:table-row-properties style:row-height="${cm(h)}" style:use-optimal-row-height="false"/></style:style>`); }

  // Combinaciones: origen (con extensión) y celdas cubiertas
  const origin = new Map<string, { cols: number; rows: number }>(), covered = new Set<string>();
  for (const m of layout.merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) {
    if (r === m.r1 && c === m.c1) origin.set(cellKey(r, c), { cols: m.c2 - m.c1 + 1, rows: m.r2 - m.r1 + 1 }); else covered.add(cellKey(r, c));
  }

  const rows: string[] = [];
  for (let r = 0; r < layout.nRows; r++) {
    const rid = layout.rowHeights[r] ? ` table:style-name="${rowIds.get(layout.rowHeights[r])}"` : '';
    let cells = '';
    for (let c = 0; c < layout.nCols; c++) {
      const k = cellKey(r, c);
      if (covered.has(k)) { cells += '<table:covered-table-cell/>'; continue; }
      const cell: LCell | undefined = layout.cells.get(k), span = origin.get(k);
      const attrs = [`table:style-name="${styleFor(cell?.style ?? blank)}"`];
      if (span) attrs.push(`table:number-columns-spanned="${span.cols}"`, `table:number-rows-spanned="${span.rows}"`);
      if (!cell || cell.v === undefined) { cells += `<table:table-cell ${attrs.join(' ')}/>`; continue; }
      if (typeof cell.v === 'number') {
        if (cell.f) attrs.push(`table:formula="${esc(odsFormula(cell.f))}"`);
        cells += `<table:table-cell ${attrs.join(' ')} office:value-type="float" office:value="${cell.v}"><text:p>${cell.v}</text:p></table:table-cell>`;
      } else cells += `<table:table-cell ${attrs.join(' ')} office:value-type="string"><text:p>${esc(cell.v)}</text:p></table:table-cell>`;
    }
    rows.push(`<table:table-row${rid}>${cells}</table:table-row>`);
  }

  const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns} office:version="1.2">` +
    `<office:font-face-decls><style:font-face style:name="Arial" svg:font-family="Arial"/></office:font-face-decls>` +
    `<office:automatic-styles>${colIds.map(c => c.xml).join('')}${rowXml.join('')}${styleXml.join('')}` +
    `<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style></office:automatic-styles>` +
    `<office:body><office:spreadsheet><table:table table:name="${esc(layout.sheetName)}" table:style-name="ta1">` +
    colIds.map(c => `<table:table-column table:style-name="${c.id}"/>`).join('') + rows.join('') + `</table:table></office:spreadsheet></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns} office:version="1.2">` +
    `<office:font-face-decls><style:font-face style:name="Arial" svg:font-family="Arial"/></office:font-face-decls>` +
    `<office:styles><style:default-style style:family="table-cell"><style:text-properties style:font-name="Arial" fo:font-size="10pt"/></style:default-style>` +
    `<style:style style:name="Default" style:family="table-cell"/></office:styles>` +
    // Hoja horizontal tamaño oficio, ajustada a una página de ancho
    `<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="35.56cm" fo:page-height="21.59cm" style:print-orientation="landscape" fo:margin-left="1cm" fo:margin-right="1cm" fo:margin-top="1cm" fo:margin-bottom="1cm" style:scale-to-X="1" style:scale-to-Y="0"/></style:page-layout></office:automatic-styles>` +
    `<office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"><office:meta><meta:generator>Relevo</meta:generator><meta:creation-date>${new Date().toISOString()}</meta:creation-date></office:meta></office:document-meta>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>` +
    ['content.xml', 'styles.xml', 'meta.xml'].map(f => `<manifest:file-entry manifest:full-path="${f}" manifest:media-type="text/xml"/>`).join('') + `</manifest:manifest>`;

  // El archivo «mimetype» va primero y sin comprimir (lo exige el formato)
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', manifest); zip.file('content.xml', content); zip.file('styles.xml', styles); zip.file('meta.xml', meta);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' });
}

