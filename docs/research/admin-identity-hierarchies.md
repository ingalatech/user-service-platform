# Jerarquías de administración de identidad

Fecha de consulta: **2026-10-29**. Investigación para [#267](https://github.com/ingalatech/user-service-platform/issues/267), insumo de la decisión HITL [#266](https://github.com/ingalatech/user-service-platform/issues/266).

## Alcance y método

Se compara sólo arquitectura de información: navegación global, agrupación, orden y proximidad de tareas. Se excluyen colores, estética y recomendaciones de componentes. La implementación visual ya está fijada en Marmelab Shadcn Admin Kit v2 por [`admin/README.md`](../../admin/README.md) y [ADR-0012](../adr/0012-admin-spa-same-origin-assets.md).

- **Observado** significa que una fuente primaria actual documenta la ruta o que el código abierto ejecutable la implementa.
- **Inferencia** significa una conclusión de diseño derivada de esos hechos; no se atribuye al producto observado.
- Para PocketBase se inspeccionó el código de Dashboard en el commit [`7f2773e`](https://github.com/pocketbase/pocketbase/tree/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src). Para Clerk y Auth0 se usaron manifiestos y documentación oficiales. No se accedió a tenants autenticados.

## Restricciones ya decididas en User Service

Esto mapea requisitos; no los modifica.

| Requisito             | Decisión existente                                                                                                                                                                                     | Implicación para la jerarquía                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Realms                | Reader y Administrator son identidades independientes; igual email no las vincula ([ADR-0014](../adr/0014-admin-reader-identity-isolation.md))                                                         | No mezclar Administrators con Readers ni presentar una conversión de realm.                                 |
| Estado                | Acceso `active`/`disabled`, solicitud de eliminación y acceso efectivo son ejes distintos ([#257](https://github.com/ingalatech/user-service-platform/issues/257#issuecomment-6505481272))             | Mostrar los tres juntos, sin reducirlos a un único estado. La revisión de eliminación necesita área propia. |
| Email y contraseña    | Verificación forzada/reenvío, recuperación y cambio de email pendiente son workflows distintos ([#264](https://github.com/ingalatech/user-service-platform/issues/264#issuecomment-6505832896))        | Agruparlos como acceso/credenciales, sin esconder el email pendiente en datos de perfil.                    |
| Proveedores           | Se listan asociaciones opacas y se desvincula una asociación concreta; nunca se vincula por el Reader ([#261](https://github.com/ingalatech/user-service-platform/issues/261#issuecomment-6506020815)) | Los proveedores pertenecen al detalle Reader, próximos a los demás métodos de acceso.                       |
| Sesiones              | Lista de sesiones Reader activas y revocación individual o total ([#262](https://github.com/ingalatech/user-service-platform/issues/262#issuecomment-6506439123))                                      | Sesiones es una tarea recurrente propia, no una acción opaca de “reset tokens”.                             |
| Actividad y auditoría | Un Event Ledger produce timeline por Reader y auditoría global ([#259](https://github.com/ingalatech/user-service-platform/issues/259#issuecomment-6506300786))                                        | Separar **Actividad del Reader** contextual de **Auditoría administrativa** global.                         |
| Administrators        | Cuentas e invitaciones son conjuntos distintos; todos tienen autoridad equivalente ([#263](https://github.com/ingalatech/user-service-platform/issues/263#issuecomment-6506564338))                    | Recurso global separado con vistas explícitas de cuentas e invitaciones; no “roles” como eje principal.     |
| Shell existente       | El Admin ya tiene lista `Users`, detalle diferido y contratos application-owned ([`admin/README.md`](../../admin/README.md))                                                                           | Evolucionar la lista existente hacia el detalle Reader; no introducir otra consola o API de proveedor.      |

## Comparación de jerarquías observadas

### Resumen

| Capacidad solicitada               | PocketBase                                                                                                                                                                                       | Clerk Dashboard                                                                                                                                                                                              | Auth0 Dashboard                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navegación global de identidades   | **Observado:** `Collections`, `Logs`, `Settings`; los usuarios son registros de una colección auth.                                                                                              | **Observado:** `Users` y logs están en alcance de aplicación; `Team` está en alcance de workspace.                                                                                                           | **Observado:** `Users` es primario en la navegación nueva; `Logs` está en `Security & Monitoring`; miembros del tenant están en `Settings`.                                              |
| Identidad/perfil y datos de cuenta | **Observado:** modal de registro, pestaña `Account`, primero email/contraseña/verificación y luego campos de colección.                                                                          | **Observado:** perfil de usuario con información personal, identificadores/cuentas conectadas y metadata; tabs de ruta `profile`, `settings`, `organizations`, `subscriptions`, `payments`.                  | **Observado:** `Details` contiene `User Identity`, metadata, atributos del IdP, passkeys y MFA; `Raw JSON` está separado.                                                                |
| Verificación de email              | **Observado:** estado editable en `Account`; `Send verification email` en menú de más acciones.                                                                                                  | **Observado:** el perfil incluye identificadores; los logs registran verificación. La documentación pública consultada no confirma una acción administrativa de forzar o reenviar verificación en el perfil. | **Observado:** `Send Verification Email` está en `Actions`; el estado forma parte de la identidad. La API permite marcar verificado.                                                     |
| Contraseña/recuperación            | **Observado:** cambio directo de contraseña dentro de `Account`; envío de reset en el menú de más acciones.                                                                                      | **Observado:** acciones de contraseña existen y se auditan; las fuentes públicas consultadas no exponen el orden exacto dentro del perfil.                                                                   | **Observado:** `Users` permite password resets; la documentación consultada no fija su posición exacta actual dentro de `Details`.                                                       |
| Proveedores sociales vinculados    | **Observado:** pestaña hermana `Auth providers`, lista y desvinculación por fila.                                                                                                                | **Observado:** `connected accounts` pertenece a identificadores en el perfil; desconectar se registra como acción administrativa.                                                                            | **Observado:** identidades/connections se resumen en `Details`; vincular/desvincular se documenta principalmente como API o UI de la aplicación, no como tarea confirmada del Dashboard. |
| Sesiones vivas/revocación          | **No expuesto:** no lista sesiones. `Reset issued tokens` es una acción global del registro.                                                                                                     | **Observado:** sección `Devices` dentro del usuario, con `Revoke device` y `Revoke all devices`.                                                                                                             | **Observado:** `Devices` lista dispositivos y permite `Unlink` para revocar su refresh token. No se confirmó una lista de todas las sesiones autoritativas equivalente a User Service.   |
| Estado habilitado/deshabilitado    | **No expuesto:** no hay estado de cuenta incorporado; podría ser un campo application-owned de colección, lo cual sería configuración del cliente.                                               | **Observado:** `ban` revoca sesiones e impide login; `unban` revierte. `lock` es un concepto distinto, orientado a intentos fallidos.                                                                        | **Observado:** `Block user`/`Unblock` vive en `Details` y en el menú de más acciones; no expira automáticamente.                                                                         |
| Solicitud/revisión de eliminación  | **No expuesto:** sólo eliminación material del registro.                                                                                                                                         | **No expuesto en fuentes consultadas:** existe eliminación material desde `Actions`; no se documenta cola de solicitud/revisión.                                                                             | **No expuesto:** `Delete user` al final de `Details` elimina permanentemente tras confirmar.                                                                                             |
| Actividad del ciclo de vida        | **Limitado:** `Logs` es global y operacional; no hay timeline de ciclo de vida en el registro.                                                                                                   | **Observado:** `Application Logs` es global, filtrable por User ID/identificador/actor/sujeto; no se confirmó un timeline embebido en el perfil.                                                             | **Observado:** `History` es una pestaña del usuario y muestra dos días; `Monitoring > Logs` es global e incluye autenticación y acciones administrativas.                                |
| Identidades administrativas        | **Observado:** `Manage superusers` está en el menú de la identidad autenticada y abre la colección `_superusers`; sus registros no muestran la pestaña de proveedores y son siempre verificados. | **Observado:** `Team` es un recurso de workspace separado de `Users`; permite gestionar miembros y roles.                                                                                                    | **Observado:** `Settings > Tenant Members` separa operadores de `User Management > Users` y muestra roles/MFA.                                                                           |
| Invitaciones administrativas       | **No expuesto:** se crean superusers directamente; no hay workflow de invitación en el Dashboard inspeccionado.                                                                                  | **Observado:** `Team > Invite user`; invitación desde el encabezado o página Team.                                                                                                                           | **Observado:** `Settings > Tenant Members > Add Member`; invitaciones pendientes aparecen en lista con eliminar/copiar enlace.                                                           |

### PocketBase: registro primero

**Observado.** La cabecera global implementa exactamente `Collections`, `Logs`, `Settings`; `Settings` añade navegación secundaria agrupada en `System`, `Sync` y `Debug` ([`store.js`](https://github.com/pocketbase/pocketbase/blob/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src/store.js#L58-L125)). Los usuarios no son un recurso global especial: son registros de una colección `auth` abiertos en un modal.

**Observado.** Para un registro auth existente, el modal tiene sólo `Account` y `Auth providers`. `Account` ordena email, contraseña, verificación y después campos propios. El menú de más acciones contiene enviar verificación, enviar recuperación, impersonar, resetear todos los tokens y eliminar. `Auth providers` lista asociaciones y permite desvincular ([`recordUpsertModal.js`](https://github.com/pocketbase/pocketbase/blob/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src/records/recordUpsertModal.js#L500-L568), [tabs y acciones](https://github.com/pocketbase/pocketbase/blob/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src/records/recordUpsertModal.js#L694-L859), [proveedores](https://github.com/pocketbase/pocketbase/blob/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src/records/recordUpsertModal.js#L1343-L1469)).

**Observado.** `Manage superusers` está en el menú de cuenta, no en la navegación global, y abre `_superusers` como otra colección ([`appHeader.js`](https://github.com/pocketbase/pocketbase/blob/7f2773ec234b62d0b80ca47c508397cb3d0da3ea/ui/src/base/appHeader.js#L60-L96)).

**Inferencia.** PocketBase ofrece la referencia más compacta para co-localizar credenciales y proveedores, pero su jerarquía centrada en registros no representa sesiones enumerables, estados separados, revisión de eliminación ni dos lecturas de eventos. Copiarla haría invisibles requisitos ya decididos.

### Clerk: usuario rico, equipo y logs separados

**Observado.** El [manifiesto oficial del Dashboard](https://dashboard.clerk.com/llms.txt) separa alcance de workspace (`Applications`, `Team`, `Workspace settings`, facturación) y alcance de aplicación (`Users`, `Organizations`, `Logs`, `Email logs`, configuración). La ruta individual de usuario declara vistas `profile`, `settings`, `organizations`, `subscriptions`, `payments`.

**Observado.** El [perfil de usuario](https://clerk.com/docs/guides/dashboard/user-profile) agrupa primero información personal, identificadores (emails, teléfonos, cuentas conectadas) y metadata; desde esa sección ofrece actualizar, impersonar, bloquear, banear o eliminar. Organizaciones y Billing son secciones aparte. Los dispositivos y revocación están dentro del usuario: `Revoke device` y `Revoke all devices` ([Session options](https://clerk.com/docs/guides/secure/session-options#changes-to-existing-sessions)).

**Observado.** Clerk separa [Application Logs, Email Logs y Admin Logs](https://clerk.com/docs/guides/dashboard/logs/overview). Application Logs permiten filtrar por usuario, actor y sujeto; Admin Logs registran acciones de operadores, incluidas revocación de sesión, ban/unban, eliminación y desconexión de proveedor ([Admin Logs](https://clerk.com/docs/guides/dashboard/logs/admin-logs#user-events)). `Team` reúne miembros e invitación de operadores ([workspace](https://clerk.com/docs/guides/dashboard/overview#invite-and-manage-team-members)).

**Inferencia.** Es la coincidencia estructural más fuerte para separar Readers, Administrators y auditoría, y para hacer de sesiones una tarea contextual del Reader. No aporta un precedente para solicitud/revisión de eliminación; tampoco su distinción `lock`/`ban` debe sustituir los estados ya definidos en #257.

### Auth0: recursos globales amplios y detalle operativo por pestañas

**Observado.** La navegación nueva de Auth0, aún **Early Access**, sitúa `Users`, `Organizations` y `Settings` como primarios; agrupa configuración en `Integration` y logs en `Security & Monitoring` ([Navigate Auth0 Dashboard](https://auth0.com/docs/get-started/auth0-overview/dashboard/use-dashboard-navigation)). La navegación clásica documentada usa `User Management > Users`, `Monitoring > Logs` y `Settings` ([Dashboard overview](https://auth0.com/docs/get-started/auth0-overview/dashboard)).

**Observado.** User Details tiene cinco tabs y este orden: `Details`, `Devices`, `History`, `Locations`, `Raw JSON`. `Details` agrupa identidad, metadata, atributos IdP, passkeys y MFA; `Devices` revoca refresh tokens; `History` muestra dos días de actividad ([View User Details](https://auth0.com/docs/manage-users/user-accounts/view-user-details)). Bloqueo vive en `Details` y en el menú de más acciones ([Block/unblock](https://auth0.com/docs/manage-users/user-accounts/block-and-unblock-users)); reenviar verificación vive en `Actions` ([Resend verification](https://auth0.com/docs/manage-users/user-accounts/resend-verification-emails)); eliminar está al final de `Details` ([Delete users](https://auth0.com/docs/manage-users/user-accounts/delete-users)).

**Observado.** Los operadores están en `Settings > Tenant Members`, con roles y MFA, y las invitaciones pendientes permanecen en una lista ([Tenant settings](https://auth0.com/docs/get-started/tenant-settings#tenant-members), [Add tenant members](https://auth0.com/docs/get-started/manage-dashboard-access/add-dashboard-users)). Los logs globales incluyen autenticación y acciones administrativas ([View logs](https://auth0.com/docs/deploy-monitor/logs/view-log-events)).

**Inferencia.** Auth0 aporta el precedente más claro para ordenar detalle, sesiones/dispositivos y actividad como tabs hermanas. Ubicar Administrators dentro de `Settings` sería menos coherente aquí: en User Service son un realm operacional de primera clase con detalle, estado e invitaciones, no mera configuración del tenant.

## Hallazgos transversales

1. **Separación global por tipo de actor.** Clerk `Users`/`Team` y Auth0 `Users`/`Tenant Members` mantienen usuarios finales y operadores en recursos distintos. Esto respalda la frontera de ADR-0014.
2. **El trabajo sobre una identidad permanece contextual.** Los tres productos abren primero una lista/colección y concentran identidad, credenciales y acciones en el detalle. Ninguno eleva verificación, recuperación o proveedores vinculados a recursos globales independientes.
3. **Sesiones merecen agrupación propia cuando son enumerables.** Clerk usa `Devices` dentro del usuario y Auth0 una pestaña `Devices`; PocketBase sólo ofrece reset opaco de tokens. El contrato de #262 se parece a Clerk/Auth0, no a PocketBase.
4. **Actividad contextual y auditoría global responden preguntas diferentes.** Auth0 combina `History` por usuario con `Logs` global; Clerk mantiene logs globales filtrables y distingue auditoría administrativa. Esto coincide directamente con las dos proyecciones de #259.
5. **La revisión de eliminación es diferenciadora.** Ningún producto consultado expone la máquina `pending_review`/`approved`/`rejected`/`cancelled`. Debe diseñarse desde #257, no esconderse bajo una acción de borrado material observada.
6. **Las invitaciones pertenecen al recurso de operadores.** Clerk las inicia desde `Team`; Auth0 desde `Tenant Members`. PocketBase carece de workflow. Esto respalda cuentas e invitaciones como vistas hermanas dentro de Administrators.

## Limitaciones de fuentes

- Clerk y Auth0 son productos autenticados y no se dispuso de un tenant de prueba. Sus manifiestos y documentos oficiales permiten afirmar rutas y agrupaciones documentadas, pero no todo el orden interno actual de cada panel.
- La documentación pública de Clerk confirma perfil, acciones, dispositivos y eventos, pero no confirmó una acción administrativa de forzar/reenviar verificación ni la posición exacta de contraseña/proveedores dentro de la UI actual. Se marca como no confirmado, no como ausencia de API.
- Auth0 mantiene documentación de navegación clásica y una navegación nueva Early Access al mismo tiempo. Se informan ambas; la nueva no se trata como jerarquía universal.
- Auth0 documenta linking/unlinking principalmente mediante Management API o UI application-owned, no como capacidad confirmada del Dashboard ([linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking), [unlinking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/unlink-user-accounts)).
- PocketBase sí pudo inspeccionarse a un commit concreto, pero es una consola genérica de colecciones. La ausencia significa que el Dashboard base no ofrece la capacidad, no que una aplicación PocketBase no pueda modelarla.

## Candidatas para la decisión HITL

### Candidata A: tareas explícitas, detalle de una sola página

**Navegación global exacta**

1. `Lectores`
2. `Administradores`
3. `Auditoría administrativa`

**Detalle de Reader, orden exacto de grupos**

1. `Resumen`: identidad/perfil, datos de cuenta, email canónico y los tres estados (acceso, solicitud de eliminación, acceso efectivo).
2. `Acceso y credenciales`: verificación/cambio de email, contraseña/recuperación, proveedores sociales.
3. `Sesiones activas`: lista, revocación individual y total.
4. `Ciclo de vida`: deshabilitar/rehabilitar y solicitud/revisión de eliminación.
5. `Actividad`: timeline del Reader.

`Administradores` contiene vistas `Cuentas` e `Invitaciones`; cada cuenta abre `Resumen`, `Acceso y credenciales` y `Actividad` en ese orden.

**Tradeoff.** Mantiene todas las tareas visibles y minimiza navegación interna, como la compactación de PocketBase. Puede producir una página larga y duplica estado en `Resumen` y acciones en `Ciclo de vida`; exige anclas o disclosure para no perder orientación.

### Candidata B: perfil y seguridad primero, lifecycle separado

**Navegación global exacta**

1. `Lectores`
2. `Administradores`
3. `Auditoría administrativa`

**Detalle de Reader, tabs y orden exactos**

1. `Resumen`: identidad/perfil, datos de cuenta, email canónico, métodos disponibles y los tres estados.
2. `Acceso`: email y verificación; cambio de email pendiente; contraseña y recuperación; proveedores sociales vinculados.
3. `Sesiones`: sesiones activas, revocación individual y total.
4. `Ciclo de vida`: estado habilitado/deshabilitado; solicitud, revisión y resultado de eliminación.
5. `Actividad`: timeline del Reader.

`Administradores` contiene tabs `Cuentas` e `Invitaciones`. El detalle de cuenta usa `Resumen`, `Acceso` y `Actividad`; no muestra sesiones, proveedores, cambio de email ni eliminación porque #263 los excluye.

**Tradeoff.** Adopta el patrón probado de Clerk/Auth0 para separar perfil, sesiones y actividad, y da espacio explícito al workflow propio de eliminación. Requiere un salto adicional entre tabs y una regla clara: `Resumen` informa estado; `Ciclo de vida` lo gobierna.

### Candidata C: detalle operativo condensado al estilo Auth0

**Navegación global exacta**

1. `Lectores`
2. `Administradores`
3. `Registro`

**Detalle de Reader, tabs y orden exactos**

1. `Detalles`: identidad/perfil, datos de cuenta, email/verificación, contraseña/recuperación, proveedores, estado y solicitud de eliminación.
2. `Sesiones`: sesiones activas y revocación.
3. `Actividad`: timeline del Reader.

`Administradores` contiene tabs `Cuentas` e `Invitaciones`. `Registro` abre por defecto `Auditoría administrativa` y permite cambiar a `Actividad de cuentas`.

**Tradeoff.** Tiene la menor cantidad de destinos y refleja `Details`/`Devices`/`History` de Auth0. Sin embargo, `Detalles` acumula demasiados workflows y `Registro > Actividad de cuentas` duplica una lectura que ya es contextual; además “Registro” debilita la distinción de #259 entre actividad y auditoría.

**Recomendación para discutir, no decisión:** llevar **Candidata B** como default al HITL y contrastarla con A. Es la única que combina evidencia convergente de Clerk/Auth0 (identidad primero, sesiones y actividad separadas), la separación global de operadores observada en ambos y una agrupación explícita para la máquina de eliminación que ningún referente resuelve. Preguntas decisivas: (1) ¿`Ciclo de vida` merece tab por frecuencia/riesgo o sección en una página única?, (2) ¿el resumen debe mostrar sólo estados y métodos o también acciones rápidas no destructivas?, y (3) ¿`Administradores` debe abrir `Cuentas` o recordar la última vista entre `Cuentas` e `Invitaciones`?
