import { Worker } from 'node:worker_threads';
import type { Config, Grid } from '../engine/index.js';

/**
 * La generación corre en un worker_thread. Hay un solo worker, creado al primer uso y reutilizado:
 * las peticiones se encolan en el hilo y no se paga el arranque en cada una.
 * El runtime es siempre tsx (npm start / dev / vitest), por eso el worker carga el .ts con `--import tsx`.
 */
const TIMEOUT_MS = 30_000;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (g: Grid) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function failAll(err: Error) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(err); pending.delete(id); }
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../workers/generate.worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
  w.unref(); // un worker ocioso no impide que el proceso termine
  w.on('message', ({ id, grid, error }: { id: number; grid?: Grid; error?: string }) => {
    const p = pending.get(id); if (!p) return;
    clearTimeout(p.timer); pending.delete(id);
    if (grid) p.resolve(grid); else p.reject(new Error(error ?? 'Falló la generación'));
  });
  w.on('error', err => { worker = null; failAll(err); });
  w.on('exit', () => { if (worker === w) worker = null; failAll(new Error('El generador se detuvo')); });
  worker = w;
  return w;
}

export function generateInWorker(cfg: Config): Promise<Grid> {
  return new Promise<Grid>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error('La generación tardó demasiado'));
      worker?.terminate(); worker = null; // un hilo atascado se descarta; el siguiente pedido crea otro
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { ensureWorker().postMessage({ id, cfg }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e as Error); }
  });
}

export async function closeGenerator() { const w = worker; worker = null; await w?.terminate(); }
