# Mejoras propuestas (no implementar sin aprobación)

- **Paginación del directorio.** El plan la menciona para terapeutas y auditoría; el mockup no tiene paginación y hoy son 18 registros. `GET /therapists` devuelve la lista completa (con filtros en el servidor). Agregar `page`/`limit` cuando el directorio crezca.
- **Eliminar un usuario que es dueño de cuadros.** Hoy se permite (como en el mockup) y la tarjeta mostraría «Creado por» vacío. Valorar impedirlo (409) o reasignar los cuadros.
- **Recuperar contraseña y cambiar la propia.** No están en el mockup; el plan lo deja a la espera de elegir proveedor de correo.
- **Consulta de auditoría.** Se registran creaciones, ediciones y borrados de usuarios, servicios y terapeutas en `auditLogs`, pero no hay pantalla para leerlos.
- **`trust proxy` y cookies detrás de un balanceador** (fase 6): el límite de intentos por IP necesita `app.set('trust proxy', …)` en producción.

- **Huella del motor duplicada en dos repos.** El algoritmo vive en `scripts/engine-hash.mjs` (backend) y en `frontend/scripts/sync-engine.mjs`; si se cambia hay que cambiarlo en los dos. Valorar publicar el motor y los esquemas como paquete privado (npm/GitHub Packages) cuando el equipo crezca.
- **El plan no tiene la sección «Estructura de los repositorios».** `referencia/` del frontend conserva la versión anterior del plan.

- **Evitar cruces entre servicios al generar.** Hoy se detectan y se marcan como error crítico (como el mockup), pero el motor no sabe qué días ya ocupan otros cuadros. El plan lo prevé para la 1.0: exige cambiar `src/engine` (pasar los días ocupados), regenerar `engine-golden.json` y sincronizar el frontend.
- **Bloquear la edición de un cuadro Publicado.** El mockup (y hoy la app) deja editar un cuadro publicado; publicar solo cambia el estado. Valorar pedir «Volver a borrador» antes de editar.
- **Eliminar un cuadro.** No está en el mockup ni en el plan; hoy un cuadro creado por error no se puede borrar desde la interfaz.
- **Listar cuadros sin cargarlos todos.** `GET /schedules` lee todos los cuadros para calcular los cruces de las tarjetas; con mucho histórico conviene limitar a los meses visibles.
- **Auditar casillas individuales.** Se audita crear, generar, cambiar reglas/cobertura/equipo, ausencias y publicar; pintar casillas no, para no llenar el registro.
- **Aviso de conflicto sin esperar al guardado.** El 409 se descubre al guardar (~800 ms después de pintar); un aviso en vivo (SSE o sondeo) lo anticiparía.

- **Elegir un rango de meses libre en el resumen.** La API acepta cualquier `from`/`to` (`AAAA-MM`), pero la pantalla ofrece solo lo del mockup: los tres meses más recientes y su rango.
- **Contar un cruce entre servicios una sola vez.** El resumen y las tarjetas lo cuentan una vez por cada cuadro afectado (un cruce suma 2), igual que el mockup; podría mostrarse como 1 cruce.
- **Etiqueta del rango entre años.** «Noviembre a enero» no dice el año; podría mostrarse «Noviembre 2026 a enero 2027» cuando cruza el año.
- **Calcular el resumen sin leer todos los cuadros.** Lee todos los cuadros y agrega en Node; con mucho histórico conviene filtrar por meses en la consulta o agregar en MongoDB.

- **Exportar con la ausencia escrita como palabra.** El hospital escribe «PERMISO» repartido en los días de la ausencia; la exportación escribe la letra `V`, `I` o `P` (se lee y se reimporta sin ambigüedad). Si el hospital prefiere su estilo, se puede escribir la palabra completa repartida en el tramo.
- **Turnos que el motor no representa.** El cuadro real trae `MN` (mañana y noche, 18 h) y similares; hoy se avisan y quedan libres. Soportarlos exige cambiar el motor (nuevos códigos y horas) y regenerar los casos fijos.
- **Importar a varios meses o servicios de una vez.** Hoy se importa una tabla por vez; el cuadro real trae 18 tablas en 5 hojas.
- **Crear terapeutas desde el archivo.** Si un nombre no está en el directorio hoy se elige otra persona o se omite; podría ofrecer registrarla desde el mismo diálogo (el plan prevé una carga inicial del directorio desde el cuadro actual, con revisión).
- **Festivos en el archivo.** El hospital pinta de naranja días completos que parecen festivos; el formato exportado solo marca fines de semana (amarillo) y ausencias (naranja). Depende del calendario de festivos de la versión 1.1.
- **Leer a mano el ODS en LibreOffice.** El ODS se valida con pruebas (paquete, XML bien formado, lectura con SheetJS y ida y vuelta) pero no hay LibreOffice en este equipo para abrirlo: conviene abrir una vez un archivo exportado en el programa del hospital (criterio de cierre de la fase en el plan).

- **Aprobar el cambio de color del acento (`--accent`, `--err`) para cumplir WCAG AA.** Ver la decisión pendiente en el `CLAUDE.md` del frontend: es un ajuste de tono mínimo y no se aplicó sin aprobación.
- **Primer administrador en producción.** El seed está prohibido allí; falta un comando (`npm run create-admin`) que cree el primer administrador pidiendo la contraseña, para la fase de despliegue.
- **MongoDB con autenticación en el compose.** Hoy el MongoDB del compose no pide credenciales (solo escucha en 127.0.0.1). Con usuario y llave de réplica serviría también para pruebas de despliegue.
- **Copias automáticas.** `npm run backup` es manual; programarlo (cron, tarea de Windows o el proveedor) y copiar los archivos fuera del servidor.
- **Cuentas:** cambiar la propia contraseña, recuperarla por correo y bloquear cuentas tras muchos intentos fallidos (hoy solo se limitan los intentos por IP y por correo).
- **Registro de auditoría legible.** Se guarda, pero no hay pantalla para leerlo ni política de conservación (TTL).
