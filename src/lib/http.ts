import type { NextFunction, Request, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import type { ZodTypeAny, z } from 'zod';
import { Service } from '../models/index.js';
import { HttpError } from '../middleware/index.js';

/** Express 4 no atrapa promesas rechazadas: este envoltorio las manda al manejador de errores. */
export const h = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

/** Id de la URL: si no es un ObjectId válido, el recurso simplemente no existe. */
export function idParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!mongoose.isValidObjectId(v) || String(v).length !== 24) throw new HttpError(404, 'NOT_FOUND', 'No encontrado');
  return v;
}

/** Comparación de nombres sin distinguir mayúsculas ni tildes (igual que el directorio del mockup). */
export const ci = { locale: 'es', strength: 2 } as const;

/** Condición `distinto de` para filtros: con sanitizeFilter activo, los operadores `$` deben marcarse como confiables. */
export const notId = (id: string) => mongoose.trusted({ $ne: id });

/** Quita duplicados y comprueba que todos los servicios existan. */
export async function checkServices(serviceIds: string[]): Promise<string[]> {
  const uniq = [...new Set(serviceIds)];
  const found = await Service.countDocuments({ _id: mongoose.trusted({ $in: uniq }) });
  if (found !== uniq.length) throw new HttpError(400, 'VALIDATION', 'Alguno de los servicios no existe.');
  return uniq;
}
