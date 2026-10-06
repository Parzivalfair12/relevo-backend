# Turnos Respiratoria · backend

API de los cuadros de turnos mensuales para terapeutas respiratorias: cuentas y roles, servicios, directorio, cuadros con editor, resumen y Excel/ODS. Aquí vive también el **motor de turnos** y los **esquemas Zod**, fuente única que el frontend copia con un script.

Estado: fases 0 a 6 listas. Falta el piloto en paralelo con el cuadro manual y el despliegue (fases 7 y 8 del plan).

## Arranque rápido (desarrollo)
Requisitos: Node 22 y Docker. Este repo va primero; después el [frontend](../frontend).

```bash
npm install
npm run db:up            # MongoDB en Docker (réplica de un nodo) en 127.0.0.1:27018
npm run seed             # datos de ejemplo (BORRA y recarga la base «turnos»)
npm run dev              # API en http://localhost:4000/api/v1/health
```
El `.env` de desarrollo sale de `.env.example` (`cp .env.example .env`). Cambia `MONGO_URI` si quieres usar otro MongoDB.

> **Por qué el puerto 27018:** muchos equipos tienen un MongoDB instalado que ocupa el 27017. Con 27018 el de Docker nunca se mezcla con el del equipo.

**Usuarios de ejemplo** (los crea `npm run seed`):

| Rol | Correo | Contraseña | Servicios |
| --- | --- | --- | --- |
| Administrador | `admin@turnos.demo` | `admin123` | todos |
| Coordinadora | `coordinadora@turnos.demo` | `coord123` | UCI Neurocrítica, Hospitalización 7° piso |
| Coordinador | `urgencias@turnos.demo` | `urg123` | Urgencias |

El seed carga 3 usuarios, 3 servicios, 18 terapeutas y 8 cuadros (julio y agosto publicados, septiembre en borrador). Son contraseñas de ejemplo: no sirven para producción (el seed se niega a correr con `NODE_ENV=production`).

**Cuentas reales (administrador y Savitra).** Se definen en el `.env` (`ADMIN_*` y `SAVITRA_*`, contraseñas de mínimo 12 caracteres) y se crean con `npm run users:bootstrap`. A diferencia del seed, no borra nada y se puede repetir: actualiza la contraseña, el rol y los servicios de cada cuenta. Savitra queda como coordinadora con todos los servicios que existan al correrlo; si creas servicios después, vuelve a correrlo (o asígnalos desde Administración). Las credenciales no aparecen en la pantalla de inicio de sesión.

Después, en `../frontend`: `npm install` y `npm run dev` (http://localhost:5173).

## Todo en contenedores (como en producción)
```bash
cp .env.production.example .env.production      # y pon secretos reales (instrucciones dentro)
docker compose --env-file .env.production --profile app up -d --build   # MongoDB + API
# después, en ../frontend:  docker compose up -d --build                  # web con Nginx → http://localhost:8080
```
- **`--env-file .env.production` es obligatorio** para esto: sin él Compose lee el `.env` de desarrollo.
- La API **se niega a arrancar en producción** con secretos de ejemplo, repetidos o cortos, o con orígenes CORS sin https (solo `localhost` puede ir con http).
- Corre sin privilegios, con el sistema de archivos de solo lectura, y la web (Nginx) es lo único que se expone.
- Variables: `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` (aleatorios ≥ 32 caracteres, distintos), `CORS_ORIGIN` (dirección de la web), `EXPORT_CITY`, `TRUST_PROXY` (cuántos proxies hay delante; el compose pone 1), `LOG_LEVEL`.
- **MongoDB de este compose no pide usuario ni contraseña** (está solo en `127.0.0.1`). En producción usa MongoDB Atlas o un servidor propio con autenticación y copias automáticas.

## Comandos
| Comando | Qué hace |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | Tipos |
| `npm test` | Vitest: motor, casos fijos, seed, API, Excel/ODS, seguridad (necesita `db:up`; usa la base `turnos_test`) |
| `npm run engine:hash` / `engine:check` | Huella del motor y los esquemas (también en CI) |
| `npm run golden:update` | Regenera `engine-golden.json` (solo si el comportamiento del motor cambió a propósito) |
| `npm run backup` | Copia de la base en `backups/` |
| `npm run backup:verify` | **Prueba de restauración**: restaura la última copia en una base temporal y compara cada colección |
| `npm run restore -- archivo [--to base \| --replace --yes]` | Restaura (por defecto en `<base>_restore`, sin tocar la real) |
| `npm run perf` | Medición de rendimiento (72 cuadros, base aparte `turnos_perf`) |

## Copias de seguridad
`npm run backup` guarda `backups/turnos-AAAAMMDD-HHMMSS.archive.gz` y un `.json` con la huella (md5) de cada colección. `npm run backup:verify` restaura esa copia en una base temporal, compara las huellas, y borra la temporal: si dice «Restauración comprobada», los documentos son idénticos. Hazla antes de cada piloto y cada trimestre (el plan lo pide). Con Atlas o un servidor propio, las copias se hacen con sus herramientas.

## Seguridad en resumen
argon2id · token de acceso de 15 min en memoria y renovación en cookie `httpOnly`/`SameSite=Strict`/`Secure` con rotación y detección de reutilización · límite de intentos de login (IP y correo) · límites por usuaria en archivos y recálculos · Zod en cada ruta y `sanitizeFilter` · roles y alcance por servicio verificados en el servidor · cabeceras con `helmet` (CSP estricta, HSTS en producción) · guarda contra zips «bomba» y límite de 8 MB al importar · registros JSON sin contraseñas, tokens ni documentos · auditoría de cambios · cierre ordenado con SIGTERM. Detalle en `CLAUDE.md`.

## Motor y esquemas
`src/engine` y `src/shared` solo se editan aquí. Al cambiarlos: `npm run engine:hash` (y `npm run golden:update` si el comportamiento cambió a propósito), commit, y en el frontend `npm run sync:engine`. Detalle en `CLAUDE.md`.
