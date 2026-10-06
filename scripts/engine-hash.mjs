#!/usr/bin/env node
/**
 * Huella (sha256) del motor de turnos y de los esquemas compartidos.
 *
 * El backend es la ÚNICA fuente de verdad de src/engine, src/shared y engine-golden.json.
 * El frontend lleva una copia generada con `npm run sync:engine` y la vigila con esta misma huella.
 *
 *   node scripts/engine-hash.mjs            calcula y escribe engine.sha256
 *   node scripts/engine-hash.mjs --check    falla (código 1) si engine.sha256 no coincide con los archivos
 *
 * Algoritmo (idéntico en frontend/scripts/sync-engine.mjs; si se cambia, cambiar en los dos):
 *   archivos = todo lo que hay bajo src/engine y src/shared + engine-golden.json, ordenados por ruta (con "/")
 *   por cada archivo se alimenta el hash con:  ruta \0 bytes-del-contenido-con-saltos-LF \0
 *   (los saltos de línea CRLF se normalizan a LF para que Windows y Linux den la misma huella)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIRS = ['src/engine', 'src/shared'];
const FILES = ['engine-golden.json'];
const HASH_FILE = join(ROOT, 'engine.sha256');

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

export function computeHash(root = ROOT) {
  const rels = [
    ...DIRS.flatMap(d => (existsSync(join(root, d)) ? listFiles(join(root, d)).map(f => relative(root, f).split(sep).join('/')) : [])),
    ...FILES.filter(f => existsSync(join(root, f)))
  ].sort();
  if (!rels.length) throw new Error(`No hay archivos del motor bajo ${root}`);
  const h = createHash('sha256');
  for (const rel of rels) {
    const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(rel).update('\0').update(text).update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const actual = computeHash();
  if (process.argv.includes('--check')) {
    const saved = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : '(no existe engine.sha256)';
    if (saved !== actual) {
      console.error(`engine.sha256 no coincide con src/engine, src/shared y engine-golden.json.\n  guardada: ${saved}\n  actual:   ${actual}\n` +
        'Si el cambio es intencional: npm run engine:hash (y npm run golden:update si el comportamiento cambió a propósito), commit, y avisar para que el frontend corra npm run sync:engine.');
      process.exit(1);
    }
    console.log(`engine.sha256 al día: ${actual}`);
  } else {
    writeFileSync(HASH_FILE, actual + '\n');
    console.log(`engine.sha256 escrito: ${actual}`);
  }
}
