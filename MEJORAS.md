# Mejoras propuestas (no implementar sin aprobación)

- **Paginación del directorio.** El plan la menciona para terapeutas y auditoría; el mockup no tiene paginación y hoy son 18 registros. `GET /therapists` devuelve la lista completa (con filtros en el servidor). Agregar `page`/`limit` cuando el directorio crezca.
- **Auditoría: detalles traducidos y exportación.** La pantalla muestra el detalle en español aunque la interfaz esté en inglés, y no se puede exportar a Excel; pedirlo si el hospital lo necesita para una revisión.

- **Huella del motor duplicada en dos repos.** El algoritmo vive en `scripts/engine-hash.mjs` (backend) y en `frontend/scripts/sync-engine.mjs`; si se cambia hay que cambiarlo en los dos. Valorar publicar el motor y los esquemas como paquete privado (npm/GitHub Packages) cuando el equipo crezca.
- **El plan no tiene la sección «Estructura de los repositorios».** `referencia/` del frontend conserva la versión anterior del plan.

- **Cruces entre servicios al generar: solo hacia adelante.** El generador evita los días que ya ocupan los cuadros que existen en ese momento; si luego se genera o cambia el otro cuadro, se vuelve a evitar al regenerar ese, pero un cruce que ya estaba pintado no se corrige solo (se sigue avisando como error crítico). Valorar un botón «Resolver cruces».
- **Eliminar un cuadro publicado.** Hoy solo se elimina en borrador (hay que volver a borrador primero); si las coordinadoras lo piden, se puede permitir con una confirmación más fuerte.
- **Listar cuadros sin cargarlos todos.** `GET /schedules` lee todos los cuadros para calcular los cruces de las tarjetas; con mucho histórico conviene limitar a los meses visibles.
- **Auditar casillas individuales.** Se audita crear, generar, cambiar reglas/cobertura/equipo, ausencias y publicar; pintar casillas no, para no llenar el registro.
- **Aviso de conflicto sin esperar al guardado.** El 409 se descubre al guardar (~800 ms después de pintar); un aviso en vivo (SSE o sondeo) lo anticiparía.

- **Contar un cruce entre servicios una sola vez.** El resumen y las tarjetas lo cuentan una vez por cada cuadro afectado (un cruce suma 2), igual que el mockup; podría mostrarse como 1 cruce.
- **Calcular el resumen sin leer todos los cuadros.** Lee todos los cuadros y agrega en Node; con mucho histórico conviene filtrar por meses en la consulta o agregar en MongoDB.

- **Exportar con la ausencia escrita como palabra.** El hospital escribe «PERMISO» repartido en los días de la ausencia; la exportación escribe la letra `V`, `I` o `P` (se lee y se reimporta sin ambigüedad). Si el hospital prefiere su estilo, se puede escribir la palabra completa repartida en el tramo.
- **Turnos que el motor no representa.** El cuadro real trae `MN` (mañana y noche, 18 h) y similares; hoy se avisan y quedan libres. Soportarlos exige cambiar el motor (nuevos códigos y horas) y regenerar los casos fijos.
- ~~Importar a varios meses o servicios de una vez.~~ Hecho: el diálogo marca las tablas del archivo y cada una lleva su servicio, mes, tipo (planta o apoyo) y meta de horas por persona; `POST /schedules/import/batch` responde por tabla. El servicio se reconoce por el título o por abreviaturas del nombre de la hoja.
- **Crear terapeutas desde el archivo, también para coordinadoras.** Hoy solo los administradores las registran al importar (así lo exige el directorio); si se quiere que las coordinadoras lo hagan, hay que cambiar el permiso del directorio. Tampoco se pide documento ni cargo: quedan como «Terapeuta respiratoria» y se completan en Equipo.
- **Festivos en el archivo.** El hospital pinta de naranja días completos que parecen festivos; el formato exportado solo marca fines de semana (amarillo) y ausencias (naranja). Depende del calendario de festivos de la versión 1.1.
- **Leer a mano el ODS en LibreOffice.** El ODS se valida con pruebas (paquete, XML bien formado, lectura con SheetJS y ida y vuelta) pero no hay LibreOffice en este equipo para abrirlo: conviene abrir una vez un archivo exportado en el programa del hospital (criterio de cierre de la fase en el plan).

- **Aprobar el cambio de color del acento (`--accent`, `--err`) para cumplir WCAG AA en el tema claro.** Ver la decisión pendiente en el `CLAUDE.md` del frontend: es un ajuste de tono mínimo y no se aplicó sin aprobación. El modo nocturno ya cumple (revisado el 2026-10-11).
- **Elegir equipo y meta de horas al crear un cuadro.** Hoy el equipo sale solo (mes anterior o activas del servicio) y la meta de horas se fija después, persona por persona. Ver la fase 1 de `PLAN-MEJORAS.md`.
- **MongoDB con autenticación en el compose.** Hoy el MongoDB del compose no pide credenciales (solo escucha en 127.0.0.1). Con usuario y llave de réplica serviría también para pruebas de despliegue.
- **Copias automáticas.** `npm run backup` es manual; programarlo (cron, tarea de Windows o el proveedor) y copiar los archivos fuera del servidor.
- **Recuperar la contraseña por correo.** Cambiar la propia, el restablecimiento por el administrador y el bloqueo temporal ya están (fase 2); falta el correo, que depende de elegir proveedor SMTP.
- **Aviso al bloquear una cuenta.** Hoy la persona ve «Demasiados intentos» y el administrador ve la pastilla «Bloqueada»; no se envía ningún aviso.
- **Plazo de conservación de la auditoría.** Ya existe `AUDIT_RETENTION_DAYS` (0 = para siempre); falta que el hospital decida los días y que se configure en producción.
