#!/usr/bin/env node
/**
 * Copias de seguridad de la base de datos del MongoDB de Docker (servicio `mongo` de docker-compose.yml).
 *
 *   npm run backup                          copia → backups/turnos-AAAAMMDD-HHMMSS.archive.gz (+ .json con las huellas)
 *   npm run backup:verify [-- archivo]      PRUEBA DE RESTAURACIÓN: restaura la copia (la última por defecto) en una base
 *                                           temporal, compara cada colección con las huellas guardadas y borra la temporal
 *   npm run restore -- archivo [--to base]  restaura en otra base (por defecto «<base>_restore», sin tocar la real)
 *   npm run restore -- archivo --replace    restaura SOBRE la base real, reemplazando lo que haya (pide --yes)
 *
 * Las huellas son el `dbHash` de MongoDB (md5 por colección): si coinciden, los documentos son idénticos byte a byte.
 * Con MongoDB Atlas o un servidor propio, las copias se hacen con sus herramientas (mongodump/Atlas); este script es para el compose.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2), cmd = args[0];
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
// primer argumento que no es una opción ni el valor de --to / --db / --out
const positional = args.slice(1).find((a, i, arr) => !a.startsWith('--') && !(i > 0 && ['--to', '--db', '--out'].includes(arr[i - 1])));
const fail = msg => { console.error(`✖ ${msg}`); process.exit(1); };

/** Nombre de la base: --db, o el de MONGO_URI (entorno o .env), o «turnos». */
function dbName() {
  const fromFlag = flag('db'); if (typeof fromFlag === 'string') return fromFlag;
  let uri = process.env.MONGO_URI;
  const envFile = join(ROOT, '.env');
  if (!uri && existsSync(envFile)) uri = /^MONGO_URI=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1];
  return /mongodb:\/\/[^/]+\/([^?]+)/.exec(uri ?? '')?.[1] ?? 'turnos';
}
const DB = dbName();
const OUT = resolve(ROOT, typeof flag('out') === 'string' ? flag('out') : 'backups');
if (!/^[A-Za-z0-9_-]+$/.test(DB)) fail(`Nombre de base no válido: ${DB}`);

const compose = (extra, opts = {}) => spawn('docker', ['compose', 'exec', '-T', 'mongo', ...extra], { cwd: ROOT, stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'] });
const run = (extra) => new Promise((ok, ko) => {
  const p = compose(extra); let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('error', ko); p.on('close', code => (code === 0 ? ok(out) : ko(new Error(err.trim() || `salió con código ${code}`))));
});
const mongosh = async js => (await run(['mongosh', '--quiet', '--eval', js])).trim();
/** md5 por colección y cantidad de documentos de una base. */
const fingerprint = async db => JSON.parse(await mongosh(`const d = db.getSiblingDB('${db}'); const h = d.runCommand({ dbHash: 1 }).collections; const c = {}; Object.keys(h).forEach(n => { c[n] = d.getCollection(n).countDocuments({}); }); JSON.stringify({ hash: h, count: c })`));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const latest = () => { const f = existsSync(OUT) ? readdirSync(OUT).filter(x => x.endsWith('.archive.gz')).sort() : []; return f.length ? join(OUT, f.at(-1)) : null; };

async function backup() {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${DB}-${stamp()}.archive.gz`), before = await fingerprint(DB);
  if (!Object.keys(before.hash).length) fail(`La base «${DB}» está vacía o no existe: no hay nada que copiar.`);
  await new Promise((ok, ko) => {
    const p = compose(['mongodump', '--quiet', '--archive', '--gzip', '--db', DB]), w = createWriteStream(file); let err = '';
    p.stdout.pipe(w); p.stderr.on('data', d => { err += d; });
    p.on('error', ko); w.on('error', ko);
    p.on('close', code => (code === 0 ? w.end(ok) : ko(new Error(err.trim() || `mongodump salió con código ${code}`))));
  });
  const after = await fingerprint(DB);
  const changed = JSON.stringify(before.hash) !== JSON.stringify(after.hash);
  writeFileSync(`${file}.json`, JSON.stringify({ createdAt: new Date().toISOString(), db: DB, ...before, changedDuringBackup: changed }, null, 2));
  const kb = Math.round(readFileSync(file).length / 1024);
  console.log(`✔ copia de «${DB}»: ${file} (${kb} KB, ${Object.keys(before.hash).length} colecciones, ${Object.values(before.count).reduce((a, b) => a + b, 0)} documentos)`);
  if (changed) console.log('! La base cambió mientras se copiaba; las huellas pueden no coincidir. Repite la copia en un momento tranquilo.');
  return file;
}

function restoreInto(file, to, drop) {
  return new Promise((ok, ko) => {
    const p = compose(['mongorestore', '--quiet', '--archive', '--gzip', '--nsFrom', `${DB}.*`, '--nsTo', `${to}.*`, ...(drop ? ['--drop'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    createReadStream(file).pipe(p.stdin);
    p.on('error', ko); p.on('close', code => (code === 0 ? ok() : ko(new Error(err.trim() || `mongorestore salió con código ${code}`))));
  });
}

async function verify(fileArg) {
  const file = fileArg ? resolve(fileArg) : latest();
  if (!file || !existsSync(file)) fail('No hay copias en backups/. Haz una con: npm run backup');
  const side = `${file}.json`, tmp = `${DB}_verify_${Date.now()}`;
  const expected = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : null;
  console.log(`Restaurando ${basename(file)} en la base temporal «${tmp}»…`);
  let bad = 0, total = 0;
  try {
    await restoreInto(file, tmp, false);
    const got = await fingerprint(tmp);
    const want = expected ?? await fingerprint(DB); // sin archivo de huellas se compara con la base en vivo
    const names = [...new Set([...Object.keys(want.hash), ...Object.keys(got.hash)])].sort();
    total = names.length;
    for (const n of names) {
      const ok = want.hash[n] && want.hash[n] === got.hash[n];
      if (!ok) bad++;
      console.log(`  ${ok ? '✔' : '✖'} ${n.padEnd(12)} ${String(got.count[n] ?? 0).padStart(5)} documentos${ok ? '' : ` (esperaba ${want.count?.[n] ?? '—'})`}`);
    }
  } finally {
    await mongosh(`db.getSiblingDB('${tmp}').dropDatabase()`).catch(() => {}); // la temporal se borra SIEMPRE, también si algo falló
  }
  // fail() sale del proceso, por eso va después de limpiar
  if (bad) fail(`La restauración NO coincide con la copia en ${bad} colección(es).`);
  console.log(`✔ Restauración comprobada: ${total} colecciones idénticas a las de la copia${expected ? ` (hecha el ${expected.createdAt})` : ''}.`);
}

async function restore(file) {
  if (!file || !existsSync(file)) fail('Indica el archivo de la copia: npm run restore -- backups/turnos-….archive.gz');
  const replace = flag('replace') === true, to = replace ? DB : (typeof flag('to') === 'string' ? flag('to') : `${DB}_restore`);
  if (!/^[A-Za-z0-9_-]+$/.test(to)) fail(`Nombre de base no válido: ${to}`);
  if (replace && flag('yes') !== true) fail(`--replace REEMPLAZA los datos de «${DB}» por los de la copia. Si es lo que quieres, repite el comando agregando --yes.`);
  await restoreInto(resolve(file), to, replace);
  console.log(`✔ Restaurado en «${to}»${replace ? ' (se reemplazaron los datos de la base)' : ': la base real no se tocó. Para usarla, apunta MONGO_URI a esa base.'}`);
}

try {
  if (cmd === 'backup') await backup();
  else if (cmd === 'verify') await verify(positional);
  else if (cmd === 'restore') await restore(positional);
  else fail('Uso: backup | verify [archivo] | restore <archivo> [--to base | --replace --yes]  (ver el encabezado de scripts/backup.mjs)');
} catch (e) { fail(e.message.includes('docker') || /No such container|not running|no configuration file/i.test(e.message) ? `No pude hablar con el contenedor de MongoDB (¿corre «npm run db:up»?): ${e.message}` : e.message); }
