import type { ServiceDTO, TherapistDTO, UserDTO } from '../shared/index.js';

const ids = (a?: unknown[]) => (a ?? []).map(String);

export const userDTO = (u: any): UserDTO => ({
  id: String(u._id), name: u.name, email: u.email, role: u.role, status: u.status, serviceIds: ids(u.serviceIds)
});
export const serviceDTO = (s: any, counts?: { schedules: number; therapists: number }): ServiceDTO => ({
  id: String(s._id), name: s.name, color: s.color,
  ...(counts ? { scheduleCount: counts.schedules, therapistCount: counts.therapists } : {})
});
export const therapistDTO = (t: any, scheduleCount = 0): TherapistDTO => ({
  id: String(t._id), name: t.name, document: t.document ?? '', position: t.position, defaultKind: t.defaultKind,
  serviceIds: ids(t.serviceIds), active: t.active, scheduleCount
});
