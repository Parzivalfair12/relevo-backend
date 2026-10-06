/** Hilo de trabajo que ejecuta `generate` del motor, para no bloquear Express mientras otra coordinadora usa la API. */
import { parentPort } from 'node:worker_threads';
import { generate, type Config } from '../engine/index.js';

parentPort!.on('message', ({ id, cfg }: { id: number; cfg: Config }) => {
  try { parentPort!.postMessage({ id, grid: generate(cfg) }); }
  catch (e) { parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) }); }
});
