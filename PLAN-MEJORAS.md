# Plan de implementación de mejoras

Orden de trabajo acordado el 2026-10-11. Cada fase se hace en una rama, con tipos, lint, pruebas y levantar backend y frontend juntos antes de darla por hecha. Los commits van separados en cada repositorio. Las ideas nuevas se anotan en `MEJORAS.md`.

Estados: ☐ pendiente · ◐ en curso · ☑ hecha

| # | Fase | Estado |
| --- | --- | --- |
| 0 | Higiene de `MEJORAS.md` y rutas entre repos | ☑ |
| 1 | Crear cuadro con selección de equipo y meta de horas | ☑ |
| 2 | Cuentas | ◐ (falta recuperar por correo) |
| 3 | Integridad de datos | ☑ |
| 4 | Auditoría legible | ☑ |
| 5 | Operación | ⏸ aplazada (depende de dónde se aloje el sistema) |
| 6 | Resumen y archivos (mejoras pequeñas) | ◐ (faltan decisiones) |
| 7 | Motor v2 | ◐ (cruces hechos; falta `MN`) |
| 8 | Escalado | ☑ |

## Fase 0 · Higiene (hecha)
- Quitar de `MEJORAS.md` lo que ya está resuelto: `trust proxy` (existe `TRUST_PROXY`) y «primer administrador en producción» (lo cubre `npm run users:bootstrap`).
- Un solo `MEJORAS.md` (este repo); el del frontend apunta aquí.
- Las rutas `../backend` y `../frontend` de los scripts suponen carpetas con ese nombre; aquí se llaman `relevo-backend` y `relevo-frontend`. `sync:engine` ya acepta `BACKEND_DIR`; Playwright (`playwright.config.ts`, `e2e/global-setup.ts`) ahora también.
- Contraste de color (WCAG AA): se recalculó el 2026-10-11. El modo nocturno cumple; el **tema claro** sigue sin cumplir (acento 3,72:1 sobre `--accent-soft`, 4,30:1 con texto blanco; `--err` 4,42:1). Sigue pendiente la aprobación del cambio de tono.
- `CLAUDE.md` del frontend dice «Solo tema claro. Nunca modo oscuro», pero el frontend ya trae modo nocturno: actualizar la regla.

## Fase 1 · Crear cuadro con selección de equipo y meta de horas (hecha)
Hoy `POST /schedules` toma el equipo del mes anterior (o todas las activas del servicio) sin preguntar, y la meta de horas por persona (`targetHours`) solo se fija al importar o después, una persona a la vez.

El diálogo «Nuevo cuadro» pasa a tres pasos:
1. **Equipo.** Terapeutas parametrizadas del servicio con casilla; vienen marcadas las del mes anterior (o todas las activas). Tipo planta/apoyo por persona. Contador con mínimo 2. Opción de mostrar también otros servicios.
2. **Horas.** «Automática» (como hoy) o «Meta del cuadro» (un valor, por ejemplo 100 o 200, para todas las de planta; rango 0 a 744) con ajuste opcional por persona. Referencia en pantalla: horas que pide la cobertura frente a la suma de las metas, con aviso si no alcanza. Propone la meta del mes anterior.
3. **Confirmación.** Resumen (servicio, mes, equipo, horas, cobertura) y avisos (quién ya está en otro cuadro ese mes). Solo «Confirmar y generar» crea el cuadro.

Técnico:
- Backend: `team` opcional en el cuerpo de `POST /schedules` (`therapistId`, `kind`, `targetHours`), reutilizando el esquema de equipo de `src/shared`. Sin `team` se comporta como hoy. Valida activas y mínimo 2; la auditoría registra el equipo y la meta.
- Cambia `src/shared` → `npm run engine:hash`, commit y `npm run sync:engine` en el frontend. El motor no cambia (`engine-golden.json` igual).
- La meta no se asigna a personas de apoyo (el motor las usa para completar lo que falta).
- Frontend: nuevo `NewScheduleDialog`, textos en español e inglés, prueba e2e del flujo.

## Fase 2 · Cuentas (hecha, salvo la recuperación por correo)
- Hecho: cambiar la propia contraseña (`POST /auth/password`), bloqueo temporal (5 fallos seguidos en 15 min bloquean 15 min; responde como el límite de intentos), restablecer la contraseña de otra persona y desbloquear (`POST /users/:id/password` y `/unlock`), con botón «Contraseña» en la cabecera y las acciones en Administración.
- Cambiar o restablecer la contraseña sube `tokenEpoch`: los tokens de las demás sesiones (renovación y acceso) dejan de valer al instante, sin confundirse con un robo.
- Pendiente: recuperar por correo, a la espera de elegir proveedor SMTP. Mientras tanto, el administrador restablece la contraseña y se la da a la persona.
- La contraseña mínima ahora se exige también al restablecer (8 caracteres): las cuentas de ejemplo del seed (`urg123`, `coord123`, `admin123`) son más cortas y solo existen para desarrollo.

## Fase 3 · Integridad de datos (hecha)
- Eliminar un cuadro: solo en borrador, con confirmación y auditoría (`DELETE /schedules/:id`; botón en el editor).
- Eliminar a una persona dueña de cuadros: 409 `OWNS_SCHEDULES` con la cantidad; con `?reassignTo=<id>` se pasan a otra persona activa y se elimina. En Administración se elige a quién pasárselos.
- Un cuadro publicado no se edita: 409 `PUBLISHED_LOCKED` en casillas, generar, ausencias, cobertura, reglas y equipo; la interfaz lo muestra en solo lectura con aviso y «Volver a borrador». Pendiente de confirmar con las coordinadoras (decisión 3).

## Fase 4 · Auditoría legible (hecha)
- Pestaña «Auditoría» solo para administradores (`GET /audit`, de solo lectura): lo más reciente primero, filtros por tipo, acción, persona, fechas y texto del detalle, y «Cargar más» (paginación por cursor).
- Plazo de conservación: `AUDIT_RETENTION_DAYS` (0 = para siempre, que es el valor por omisión). Con un número, un índice TTL hace que MongoDB borre solo los registros más viejos; la pantalla indica el plazo vigente. **Falta que el hospital, con su área jurídica (Ley 1581 de 2012), defina los días** y que quien despliegue ponga ese valor en el `.env` de producción.
- `API_RATE_LIMIT` (300 por minuto y por IP por omisión) pasa a ser configurable; el e2e lo sube porque todo sale de una IP.
- Los detalles se guardan en español tal como se escribieron; con la interfaz en inglés se ven en español.

## Fase 5 · Operación
- MongoDB con usuario y llave de réplica en el compose.
- Copias automáticas programables y copia fuera del servidor, con la prueba de restauración existente.

## Fase 6 · Resumen y archivos (hecha, salvo lo que depende de decisiones)
- Hecho: año en el rango del resumen cuando cruza de año; rango de meses libre («Otro rango…»); el servicio de una tabla se reconoce también por abreviaturas del nombre de la hoja («UCI», «HOSP»); los administradores registran terapeutas nuevas desde el diálogo de importar (si ya existe alguien con ese nombre se usa esa persona; las coordinadoras deben pedirlo).
- Pendiente de decisión: contar un cruce como 1; ausencia como palabra; abrir un ODS en LibreOffice.
- Contar un cruce entre servicios como 1 (cambia los números respecto al mockup: requiere aprobación).
- Pendientes de confirmar con el hospital: ausencia como palabra («PERMISO»), abrir un ODS exportado en LibreOffice.

## Fase 7 · Motor v2
Un solo cambio de motor para sincronizar el frontend una vez:
- ☑ Evitar cruces entre servicios al generar: `Config.busy` con los días ocupados en otros cuadros del mes; el generador no asigna turno esos días, los descuenta de la disponibilidad al repartir horas, y el ajuste fino no mueve turnos hacia ellos. Lo fijado a mano se respeta. `engine-golden.json` ganó 2 casos y los 8 anteriores no cambiaron.
- Turnos como `MN` (mañana y noche, 18 h): antes hay que confirmar con las coordinadoras cómo se validan (descanso, secuencia, horas).

Pasos: cambiar `src/engine`, `npm run golden:update` (revisar el diff), `npm run engine:hash`, pruebas en verde, commit y `npm run sync:engine` en el frontend.

## Fase 8 · Escalado (hecha)
- Directorio por páginas: `GET /therapists/page` (25 por página, máx. 100, mismos filtros, orden alfabético) para la pantalla Equipo; `GET /therapists` sigue devolviendo todo para las listas de selección.
- Cuadros por ventana de meses: `GET /schedules?from=&to=` lee solo esos meses y el anterior (continuidad); las tarjetas son idénticas a las de la lista completa. La pantalla Cuadros muestra el mes actual y los 5 anteriores y ofrece «Mostrar meses anteriores». `GET /schedules/index` (servicio, mes y estado, sin turnos) alimenta los períodos del resumen y la comprobación de «ya existe» al importar.
- Resumen: ya no lee todo el histórico; una agregación liviana da los tres meses más recientes y solo se cargan los cuadros del período, del mes anterior y de esos tres meses. No se reescribió la lógica de agregación en MongoDB: sigue en Node sobre los cuadros del período (suficiente a esta escala).
- Aviso de conflicto en vivo: `GET /schedules/:id/version` y sondeo del editor cada 20 s y al volver a la pestaña. Sin casillas pendientes el cuadro se actualiza solo y avisa; con casillas pendientes aparece el aviso de conflicto. No usa SSE.
- Los disparadores para volver a mirar el rendimiento siguen siendo `npm run perf` y el volumen de cuadros.

## Fuera de este plan
- Auditar casillas individuales (llenaría el registro).
- Paquete privado para el motor y la huella (cuando crezca el equipo).
- Festivos de Colombia, rol de consulta, cambio de turnos y notificaciones (versión 1.1 del plan original).

## Decisiones pendientes
1. Proveedor de correo (SMTP) para recuperar contraseña.
2. Meses de conservación de la auditoría.
3. ¿Las coordinadoras aceptan «Volver a borrador» para editar un cuadro publicado?
4. ¿Aprobamos contar un cruce como 1?
5. Cambio de tono del acento en el tema claro (WCAG AA).
6. Cómo funciona `MN` en la práctica.
7. Fase 1: se asume que el mes siguiente propone la meta del mes anterior y que no se fija meta al apoyo; confirmar.

## Notas de la ejecución
- Fase 1: `GET /schedules/proposal` y `team` opcional en `POST /schedules`; diálogo de tres pasos en el frontend. Se asumió que el mes siguiente propone la meta del mes anterior y que el apoyo no lleva meta.
- El generador (`src/lib/generate.ts`) fallaba al crear cualquier cuadro (500, `ERR_UNKNOWN_FILE_EXTENSION`): `--import tsx` no se aplicaba dentro del worker. Ahora el worker registra tsx con su API. Probado con Node 22.14; con Node 23.9 (el de Homebrew) el proyecto no está verificado, usar Node 22 (`.nvmrc`).
- El e2e del frontend no pasaba el inicio de sesión por el diálogo de bienvenida; el helper ya lo cierra.
- Lint del frontend: queda un aviso previo en `e2e/a11y.spec.ts` (`console.log`), sin tocar.
