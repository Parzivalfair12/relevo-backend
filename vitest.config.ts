import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // La config del API se valida al importar: las pruebas de integración necesitan estas variables antes
    env: {
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://127.0.0.1:27018/turnos_test?replicaSet=rs0&directConnection=true',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0123',
      JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0123',
      CORS_ORIGIN: 'http://localhost:5173'
    },
    fileParallelism: false,
    testTimeout: 20000
  }
});
