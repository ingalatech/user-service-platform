# Account Administration Prototype Contract

Throwaway source for ticket #258. This document records the design answer only; it is not a production API or implementation contract.

## Shell

- Use the current Marmelab Shadcn Admin Kit v2 `Layout`, `AppSidebar`, header, responsive sidebar drawer, theme control, locale control, refresh control, and user menu.
- Keep the owned Admin content width, density, Inter typography, semantic color tokens, `Button`, `Separator`, and existing `users-list`/`users-detail` language.
- The prototype route uses a static, local Admin identity/data adapter only to let the real shell render without credentials or backend calls. This seam exists only on the throwaway branch.

## Allowed Page Templates

1. Resource list: searchable collection rows/table with predictable list pagination and a record-detail action.
2. Record detail: one Reader record header, stable section navigation, compact local sections, and contextual actions.
3. Settings: grouped configuration sections with explicit save state and destructive controls separated from routine settings.

No additional page grammar or visual shell is introduced by this prototype.

## Feature Placement

- Reader account concerns belong to the Reader record detail: Resumen, Datos de cuenta, Acceso y seguridad, Estado de cuenta, Sesiones, and Actividad.
- Administrators and invitations belong to separate sidebar resources. They are a different administrative realm, not tabs inside a Reader record.
- Routine credential actions stay with Acceso y seguridad. Account lifecycle actions stay with Estado de cuenta. Session revocation stays with Sesiones. Durable audit history stays with Actividad.
- Destructive actions live in a visually and semantically separated danger zone or action group.

## Canonical Record Detail

1. Breadcrumb back to Usuarios.
2. Reader identity header with name, email, opaque identifier, status, and overflow affordance.
3. Stable section index for the six Reader sections.
4. Summary first, followed by account fields, security, account state, sessions, and activity in that order.
5. Compact `dl` field presentation consistent with the current owned detail view.
6. Social unlink is the only critical irreversible confirmation. Disable and session revocation use simple confirmations. Reset/resend remain routine actions without confirmation.
7. All sections remain reachable by keyboard, use labelled landmarks/headings, and collapse to a readable single column on mobile.

## Visual Decision

PocketBase is used only as IA inspiration: predictable resource list to record detail, compact stable sections, and local actions. No PocketBase CSS or code is copied. The visual language is the current Marmelab Shadcn Admin Kit and this repository's owned Admin list/detail surface.
