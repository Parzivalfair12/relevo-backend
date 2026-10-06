import { describe, it, expect } from 'vitest';
import { buildSeedSchedules, SEED_THERAPISTS, SEED_USERS, SEED_SERVICES } from '../src/seed/data';

describe('datos de ejemplo', () => {
  const sc = buildSeedSchedules();
  it('coinciden con el mockup: 3 usuarios, 3 servicios, 18 terapeutas, 8 cuadros', () => {
    expect(SEED_USERS).toHaveLength(3); expect(SEED_SERVICES).toHaveLength(3);
    expect(SEED_THERAPISTS).toHaveLength(18); expect(sc).toHaveLength(8);
  });
  it('cada cuadro tiene un código por día y por persona', () => {
    for (const s of sc) { const n = new Date(s.year, s.month + 1, 0).getDate(); for (const m of s.members) expect(m.days).toHaveLength(n); }
  });
  it('septiembre es borrador y julio/agosto están publicados', () => {
    expect(sc.filter(s => s.month === 8).every(s => s.status === 'bor')).toBe(true);
    expect(sc.filter(s => s.month < 8).every(s => s.status === 'pub')).toBe(true);
  });
});
