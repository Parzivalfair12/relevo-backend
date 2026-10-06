# Turnos Respiratoria · backend (turnos-backend)

API (Express + Mongoose + Zod) y **fuente de verdad del motor de turnos y de los esquemas Zod** para armar los cuadros de turnos de terapeutas respiratorias de un hospital en Colombia. Todo texto visible al usuario va en español. La interfaz vive en el repositorio de la carpeta hermana `../frontend` (cada carpeta, `backend/` y `frontend/`, es un repositorio git independiente).

## Regla nueva: motor y esquemas se editan SOLO aquí
`src/engine/`, `src/shared/` y `engine-golden.json` son la fuente única. El frontend lleva una copia generada con un script, que nunca se edita a mano y se vigila con una huella (`engine.sha256`) y con casos fijos.

Si cambias algo en `src/engine/` o `src/shared/`:
1. `npm run golden:update` solo si el comportamiento del motor cambió **a propósito** (regenera `engine-golden.json`; revisa el diff: es la lista de lo que cambió).
2. `npm run engine:hash` (reescribe `engine.sha256`).
3. Pruebas en verde y commit.
4. **Avisar al usuario de que el frontend debe sincronizar** (`npm run sync:engine` en `frontend/` con `backend/` al lado).

La CI corre `npm run engine:check`: falla si los archivos no coinciden con `engine.sha256`.

Qué cubre la huella (sha256): todo lo que hay bajo `src/engine/` y `src/shared/` más `engine-golden.json`, ordenado por ruta y con saltos de línea normalizados a LF. Algoritmo en `scripts/engine-hash.mjs` (el mismo está copiado en el `sync-engine.mjs` del frontend: si se cambia, cambiar en los dos).

## Fuentes de verdad
- Motor original de referencia y mockup: en `frontend/referencia/` (`engine-referencia.js`, `mockup-referencia.html`, plan, cuadro real `.ods`). `src/engine` es su port en TypeScript (misma lógica, con una corrección anotada abajo).

## Dominio
- Turnos: M 07–13 (6 h), T 13–19 (6 h), N 19–07 (12 h), MT doble (12 h), L libre. Ausencias: V vacaciones, I incapacidad, P permiso o licencia.
- Un mes necesita 24 h × días cubiertos con cobertura 1/1/1 (720 h en 30 días).
- Secuencia deseada M → T → N → L (descanso) → M. Nunca se trabaja el día siguiente a una noche.
- Planta (`fija`) y apoyo (`apoyo`): el apoyo solo cubre cuando falta alguien de planta (modo `need`).
- Meses 0 a 11 en código; días de cuadro con índice 0 a n−1 en `locked`, día 1 a n en alertas.

## Estructura
- `src/engine/`: TypeScript puro, sin dependencias. `generate`, `validate`, `targets`, `stats`.
- `src/shared/`: constantes, esquemas Zod y tipos DTO compartidos con el frontend.
- `src/` (resto): Express + Mongoose. Rutas bajo `/api/v1` (`routes/`), `middleware/`, `models/`, `lib/`, `seed/`.
- `test/`: Vitest. Motor, casos fijos (`engine-golden.test.ts`), seed y API (integración con Supertest contra MongoDB real, base `turnos_test`).
- `scripts/`: `engine-hash.mjs` y `update-golden.ts`.
- Los imports del motor y de los esquemas son relativos (`../engine/index.js`, `../shared/index.js`). Un solo paquete, sin workspaces.

## Comandos
```bash
npm install
npm run db:up          # MongoDB en Docker (réplica de un nodo) en 127.0.0.1:27018
npm run seed           # datos de ejemplo del mockup (borra y recarga)
npm run dev            # API en :4000
npm run lint
npm run typecheck
npm test               # Vitest; las pruebas de la API necesitan db:up (usan la base turnos_test)
npm run engine:hash    # reescribe engine.sha256
npm run engine:check   # falla si engine.sha256 no coincide
npm run golden:update  # regenera engine-golden.json (solo si el comportamiento cambió a propósito)
npm run backup         # copia de la base en backups/
npm run backup:verify  # prueba de restauración (restaura en una base temporal y compara)
npm run restore -- archivo [--to base | --replace --yes]
npm run perf           # medición de rendimiento con 72 cuadros (usa la base turnos_perf)
```

## Seguridad
argon2id para contraseñas; token de acceso 15 min en memoria del cliente + token de renovación en cookie httpOnly/SameSite=Strict (Secure en producción) con rotación; `helmet`; límite de intentos en login; Zod en cada ruta; `sanitizeFilter` de Mongoose activo (los operadores `$` en filtros se marcan con `mongoose.trusted`); roles verificados en el servidor (admin ve todo; coord solo sus servicios); 409 por conflicto de versión (`__v`) en cuadros; auditoría de cambios.

## Forma de trabajar
1. Fases del plan: 0 arranque, 1 motor, 2 cuentas y directorio (hecha), 3 cuadros y editor (hecha), 4 resumen (hecha), 5 Excel y ODS (hecha), 6 endurecimiento (hecha). Siguen el piloto en paralelo y el despliegue (fases 7 y 8 del plan). Detenerse al terminar cada una.
2. Al terminar cada fase: tipos, pruebas, levantar la app y comparar con el mockup (desde el frontend).
3. Commits pequeños con mensajes claros.
4. No agregar funciones que no estén en el mockup ni en el plan. Las ideas van a `MEJORAS.md`.

### Decisiones tomadas
- El motor corrige un fallo del motor de referencia: `validate` considera la última casilla del mes anterior (`cfg.prev`) y marca error si el día 1 se trabaja tras una noche. Como `balance` usa `validate`, ya no intercambia turnos que rompan esa regla. Efecto: Hospitalización Agosto y Urgencias Agosto del seed difieren ligeramente del mockup.
- Hallazgo conocido, igual que en el mockup: Urgencias Julio queda con el día 7 sin cubrir el turno M. Es una alerta esperada de ejemplo.
- Contraseña mínima de 8 caracteres (el plan), no 6 como el mockup. Documento de la terapeuta opcional (índice único parcial).
- Sesión: el token de renovación es un JWT con `jti`; se guarda el hash del `jti` (máx. 5 sesiones por usuario). Cada token sirve una vez (consumo atómico); reutilizar uno ya usado cierra todas las sesiones de la cuenta. `authenticate` relee al usuario en cada petición.
- Login: límite de intentos fallidos por IP (30 / 15 min) y por correo (8 / 15 min); si el correo no existe se verifica un hash falso para no delatar cuentas.
- Pruebas de la API con el MongoDB de Docker (base `turnos_test`), no `mongodb-memory-server`.
- Separación de repositorios (backend / frontend): el motor y los esquemas tienen una sola fuente, este repo. La huella cubre `src/engine`, `src/shared` y `engine-golden.json`. Los casos fijos (`engine-golden.json`, 8 casos con entrada y salida esperada de `generate`, `validate`, `targets` y `stats`) los genera `scripts/update-golden.ts` y los ejecuta la misma prueba en los dos repos.
- **Fase 3 (cuadros) hecha.** Rutas: `GET/POST /schedules`, `GET/PATCH /schedules/:id`, `PUT /schedules/:id/cells`, `POST /schedules/:id/generate`, `POST/DELETE /schedules/:id/absences`, `GET /schedules/:id/validation`. Lógica en `src/lib/schedules.ts`; las rutas en `src/routes/schedules.ts`.
- **Control de versiones:** toda escritura lleva `version` (el `__v` que el cliente conoce) y se guarda con `updateOne({ _id, __v: version }, { $inc: { __v: 1 } })`. Si no coincide: 409 `VERSION_CONFLICT` con `details: { updatedByName, version }`. El cuadro guarda `updatedBy` para poder decir quién lo cambió. Dos escrituras simultáneas con la misma versión: solo una gana (prueba incluida).
- **Generación en un `worker_thread`** (`src/lib/generate.ts` + `src/workers/generate.worker.ts`): un solo worker reutilizado, creado al primer uso, con tiempo máximo de 30 s. Carga el `.ts` con `--import tsx` (el runtime es siempre tsx: `npm start`, `dev` y Vitest).
- **Qué recalcula el cuadro:** cambiar cobertura, reglas o equipo (`PATCH`), «Otra variante» / «Generar» (`/generate`), ausencias, y **soltar** una casilla fijada (`PUT /cells` con `code: null`). Pintar una casilla (`PUT /cells` con código) solo la fija y no recalcula, igual que el mockup. Cambiar el estado Publicado/Borrador no recalcula.
- **Crear un cuadro:** equipo del mes anterior del mismo servicio (solo quienes siguen activas) o, si no hay, las terapeutas activas del servicio; copia la cobertura; continúa la secuencia con las últimas 7 casillas; mínimo 2 terapeutas (400); duplicado servicio+mes (409).
- **`ScheduleDTO` trae `prev` y `busy`** para que el editor valide en vivo con el motor: `prev` = últimas casillas del mes anterior; `busy[terapeuta][día]` = servicios donde ya trabaja ese día (solo lo mínimo para detectar cruces). Los cruces entre servicios **se detectan y se avisan** (error crítico, igual que el mockup); el motor **no** los evita al generar (eso exigiría cambiar el motor: ver `MEJORAS.md`).
- **`stats`** (horas, necesarias, días sin cubrir, errores, avisos) se guarda en cada escritura. La lista de tarjetas calcula las alertas críticas en vivo (incluye cruces, que dependen de otros cuadros).
- Modo de apoyo en el esquema: `'need'` (solo si falta alguien) y `'equal'` (todas por igual); el mockup usaba `'all'` internamente.
- Cambios en `src/shared` (esquemas de cuadros, DTOs) → `engine.sha256` actualizado y copia sincronizada en el frontend. El motor y `engine-golden.json` no cambiaron.
- **Fase 4 (resumen) hecha.** `GET /dashboard?service=&from=&to=` y `GET /dashboard/therapists/:id?service=&from=&to=`. Lógica en `src/lib/dashboard.ts` (agregación, tarjetas de atención, horas por mes); rutas en `src/routes/dashboard.ts`. Se agrega en Node leyendo los cuadros del período (sin pipeline de agregación; con ~20 cuadros por mes no hace falta).
- **Período:** `AAAA-MM` con el mes de 01 a 12 (formato de URL; en el código los meses siguen siendo 0 a 11). `from`/`to` son opcionales: sin ellos se toma el mes más reciente que tenga cuadros visibles; con uno solo, ese mes. Mal escrito o invertido: 400. Un período sin cuadros devuelve ceros, no error.
- **Reglas de agregación (las del mockup):** cada terapeuta se junta a través de todos los cuadros del período aunque trabaje en dos servicios; si dos cuadros se pisan un día gana el turno de trabajo sobre el libre o la ausencia. `M` y `T` cuentan también los dobles (`MT`). «Trabaja cada» = días del período / días trabajados; «descanso medio» = promedio de días libres entre bloques de trabajo (no cuenta antes del primero ni después del último); racha máxima = días de trabajo seguidos. Fines de semana por fecha real.
- **Indicadores:** días cubiertos = días del período sin huecos de cobertura (solo reglas de cobertura del motor; los cruces no restan); horas de apoyo = horas de quienes son «apoyo» en ese cuadro; los cruces entre servicios se cuentan una vez por cuadro afectado (un mismo cruce suma 2, como en el mockup).
- **Tarjetas de atención** (calculadas en el servidor, con los textos del mockup): cuadros en borrador, cruces, horas desiguales o parejas (se compara dentro de cada servicio descontando ausencias; desigual si la diferencia supera el 12 %), quién tiene más noches, quién no tiene turnos.
- **Gráficos:** «horas por mes» = los tres meses más recientes con cuadros (respeta el filtro de servicio, no el de período, como el mockup); «horas por servicio» = servicios visibles en el período (no respeta el filtro de servicio, como el mockup).
- **Alcance:** la coordinadora solo recibe cuadros, terapeutas y servicios de los suyos; pedir otro servicio es 403; el detalle de alguien que solo trabaja en un servicio ajeno es 404.
- Cambios en `src/shared` (esquema de consulta y DTOs del resumen) → `engine.sha256` actualizado y copia sincronizada. El motor y `engine-golden.json` no cambiaron.
- **Fase 5 (Excel y ODS) hecha.** `GET /schedules/:id/export?format=xlsx|ods`, `POST /schedules/import/preview?serviceId=` (recibe el archivo como bytes, no guarda nada) y `POST /schedules/import` (crea el cuadro). Código en `src/lib/sheet-layout.ts` (diseño neutro), `src/lib/export-files.ts` (escritores), `src/lib/import-sheet.ts` (lector) y las rutas en `src/routes/schedules.ts`.
- **Librerías:** lectura de `.xlsx` y `.ods` con **SheetJS** instalado desde su CDN oficial (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`): la versión de npm está congelada en la 0.18.5, con vulnerabilidades conocidas al leer archivos subidos, y es lo que recomiendan sus autores. SheetJS gratuito **no escribe estilos**, por eso se escribe con **ExcelJS** (xlsx con colores, bordes y combinaciones) y el **ODS se escribe a mano** con JSZip (`content.xml`, `styles.xml`, `meta.xml`, `mimetype` primero y sin comprimir). Los dos escritores salen del mismo diseño, así que Excel y ODS son idénticos.
- **Formato del hospital** (copiado de la hoja `SERV-PISO` de `SEPTIEMBRE_2026_2_1.ods`): título «PROFESIONALES  SERVICIO», «CENTRO DE COSTOS», «CIUDAD, MES AÑO»; fila FECHA (días en amarillo `#FDE9A9`, etiquetas en gris `#C0C0C0`) y fila DÍAS (letra del día); dos filas por persona (turnos y horas por día, con `SUM` en la columna HORAS); **fines de semana en amarillo y ausencias en naranja `#FC5C00`**, bordes gruesos de 2 pt; leyenda de turnos al final; hoja horizontal tamaño oficio ajustada al ancho. Planta primero y luego apoyo. La ciudad sale de `EXPORT_CITY` (por defecto `Neiva`). El hospital escribe la ausencia como palabra repartida en los días («PE R MI S O»); la exportación escribe la letra `V`, `I` o `P` (más clara para leer y volver a importar).
- **Importar en dos pasos.** El lector busca en **cualquier hoja** una fila «FECHA(S)» seguida de los días 1, 2, 3… (28 a 31); de ahí salen la columna de nombres y la de cada día. Debajo, dos filas por persona (turnos y horas; el nombre puede estar en cualquiera de las dos, como pasa en el cuadro real). Se detiene en una fila de «TOTAL», «CONVENCIONES», «TURNOS»… El mes sale del encabezado («NEIVA, SEPTIEMBRE 2026») o del nombre de la hoja («MAYO_2025»). Se leen todas las tablas del libro y la usuaria elige cuál (el cuadro real trae 18, varias de otros servicios y años).
- **Cómo se lee cada casilla:** vacío = libre; `M T N MT L V I P` (mayúsculas o minúsculas, con espacios) = ese turno; **todo lo reconocido que no sea libre queda fijado a mano** (viene de lo que el hospital hizo a mano; para regenerar hay que soltarlo). Tramos de letras sueltas en días seguidos se juntan en una palabra y, si es una ausencia conocida (permiso, licencia, estudio, calamidad, compensatorio, vacaciones, incapacidad, descanso, o un prefijo de al menos 3 letras), se aplica a todo el tramo. **Lo que no se entiende queda libre (sin fijar) y se avisa con su día**: por ejemplo `MN` (mañana + noche, 18 h) del cuadro real no tiene equivalente en el motor.
- **Nombres → directorio:** coincidencia exacta sin tildes ni mayúsculas, o el nombre corto que solo cabe en una persona (mínimo dos palabras); primero entre las terapeutas del servicio y luego en todo el directorio. Si hay varias posibles no se adivina. La usuaria revisa y corrige antes de crear. El tipo (planta/apoyo) de cada persona es su tipo por defecto del directorio.
- **Límites:** 8 MB por archivo, 1.200 filas por hoja, 80 personas por tabla, 60 por cuadro. Mes duplicado: 409. Alcance por servicio como el resto de rutas de cuadros. Se audita exportar e importar.
- Cambios en `src/shared` (esquemas e interfaces de importación) → `engine.sha256` actualizado y copia sincronizada. El motor y `engine-golden.json` no cambiaron.
- **Fase 6 (seguridad y pulido) hecha.**
- **MongoDB de Docker en el puerto 27018, no 27017.** Descubierto al preparar los contenedores: el equipo tenía un `mongod` nativo en `127.0.0.1:27017` y la app (que usaba `localhost:27017`) escribía ahí, no en Docker. Las URIs de `.env.example`, `.env` y `vitest.config.ts` usan `127.0.0.1:27018`; el compose publica solo en `127.0.0.1` (MongoDB no pide credenciales en este compose).
- **Contenedores:** `Dockerfile` (Node 22, runtime tsx, usuario sin privilegios, healthcheck contra `/api/v1/health/ready`) y `docker-compose.yml` con `mongo` y, bajo el perfil `app`, `api` (sin puerto publicado, sistema de archivos de solo lectura, sin capacidades, `no-new-privileges`). Las variables de contenedor van en `.env.production` (no se sube) y se pasan con `--env-file`: sin eso Compose lee el `.env` de desarrollo y mezcla (secretos de ejemplo, CORS de :5173). La red se llama `turnos` para que la web de `../frontend` se una a ella.
- **Configuración que se rechaza en producción** (`productionProblems` en `src/config.ts`): secretos con aspecto de ejemplo, de menos de 32 caracteres o repetidos entre sí, y `CORS_ORIGIN` con `*` o sin https (salvo localhost). La API sale con el listado de problemas y código 1.
- **Capa HTTP:** `trust proxy` configurable (`TRUST_PROXY`, número de proxies; 0 por defecto para que nadie falsifique la IP), CSP estricta (`default-src 'none'`), HSTS solo en producción, `Referrer-Policy: no-referrer`; `/health` (vivo) y `/health/ready` (vivo y con base); un cuerpo demasiado grande responde **413** (antes caía en 500: lo encontró una prueba); en producción `/auth/refresh` y `/auth/logout` rechazan un `Origin` no permitido (defensa extra sobre `SameSite=Strict`).
- **Límites por usuaria** (`src/lib/limits.ts`, no por IP: varias coordinadoras comparten la red del hospital): importar y exportar 30 cada 10 min; recalcular cuadros (PATCH, generar, ausencias) 240 cada 10 min.
- **Archivos:** guarda contra zips «bomba» (suma el tamaño descomprimido que declara el directorio central: máximo 100 MB y 2.000 partes) antes de entregar el archivo a SheetJS, además de los 8 MB y 1.200 filas.
- **Registros:** pino en JSON, una línea por petición (método, ruta sin consulta, estado, ms, usuaria, IP); redacta `authorization`, cookies, contraseñas, hashes, tokens y documentos; los errores 500 se registran con su traza. **Cierre ordenado** con SIGTERM/SIGINT (deja de aceptar, espera, cierra el generador y la base; a los 15 s sale igual).
- **Copias de seguridad con prueba de restauración** (`scripts/backup.mjs`): `mongodump` dentro del contenedor, huella `dbHash` (md5 por colección) antes y después de la copia, y `backup:verify` restaura en una base temporal, compara y la borra. Probado con corrupción simulada (falla) y con desastre real (se borraron cuadros y usuarios y `restore --replace --yes` los recuperó). `restore` sin `--replace` va a `<base>_restore` y no toca la real.
- **Calidad:** ESLint (`eslint.config.js`, reglas recomendadas de JS y TypeScript; `any` permitido), un hallazgo en el motor corregido (`let` → `const`, sin cambio de comportamiento: huella actualizada y golden intacto). **Dependencias:** 0 vulnerabilidades (`npm audit`), con un `override` de `uuid` bajo `exceljs`, y vitest 5 + vite 7 (las versiones anteriores tenían avisos de desarrollo). CI: lint, auditoría de producción, construcción de la imagen y comprobación de que rechaza la configuración de ejemplo.
- **Rendimiento** (`npm run perf`, 72 cuadros de 10 personas, mediana): abrir un cuadro ~40 ms, lista de cuadros ~80 ms, resumen de 1 a 12 meses 60-75 ms, guardar casillas ~90 ms, exportar 55-100 ms, generar un cuadro en el worker ~270 ms (p95 ~560 ms); el motor tarda ~150-210 ms por mes de 7 a 25 personas. No hizo falta optimizar.
- **No resuelto en esta fase (decisión de quien despliegue):** MongoDB con usuario/contraseña y copias automáticas (Atlas o servidor propio), HTTPS, y un script de arranque que cree el primer administrador en producción (el seed está prohibido allí).
