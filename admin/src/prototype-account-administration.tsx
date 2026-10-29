import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleHelp,
  Laptop,
  Link2,
  Mail,
  MoreHorizontal,
  ShieldCheck,
  Smartphone,
  UsersRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CoreAdminContext,
  Resource,
  memoryStore,
  type AuthProvider,
  type DataProvider,
  type GetListResult,
  type GetManyReferenceResult,
  type GetOneResult,
  type RaRecord,
} from 'ra-core';
import { Link } from 'react-router';
import { Layout } from './kit/components/admin/layout.js';
import { Button } from './kit/components/ui/button.js';
import { Separator } from './kit/components/ui/separator.js';
import { i18nProvider } from './i18n.js';

// Throwaway answer for ticket #258: one canonical Reader record detail on the real Admin shell.

const prototypeIdentity = {
  id: 'prototype-admin',
  email: 'admin@example.com',
  role: 'admin',
  emailVerified: true,
  fullName: 'Administrador de prototipo',
};

const prototypeAuthProvider: AuthProvider = {
  login: () => Promise.resolve(),
  logout: () => Promise.resolve(),
  checkAuth: () => Promise.resolve(),
  checkError: () => Promise.resolve(),
  getIdentity: () => Promise.resolve(prototypeIdentity),
  getPermissions: () => Promise.resolve('admin'),
};

function emptyList<RecordType extends RaRecord>(): Promise<GetListResult<RecordType>> {
  return Promise.resolve({ data: [] as RecordType[], total: 0 });
}

function emptyRecord<RecordType extends RaRecord>(): Promise<GetOneResult<RecordType>> {
  return Promise.resolve({ data: { id: 'prototype' } as RecordType });
}

function emptyMany(): Promise<{ data: never[] }> {
  return Promise.resolve({ data: [] });
}

function emptyReference<RecordType extends RaRecord>(): Promise<
  GetManyReferenceResult<RecordType>
> {
  return Promise.resolve({ data: [] as RecordType[], total: 0 });
}

const prototypeDataProvider: DataProvider = {
  supportAbortSignal: false,
  getList: emptyList,
  getOne: emptyRecord,
  getMany: emptyMany,
  getManyReference: emptyReference,
  create: emptyRecord,
  update: emptyRecord,
  updateMany: () => Promise.resolve({ data: [] }),
  delete: emptyRecord,
  deleteMany: () => Promise.resolve({ data: [] }),
};

const reader = {
  id: 'usr_01H8M4K7R2Q9',
  name: 'María García López',
  email: 'maria.garcia@example.com',
  role: 'Reader',
  joined: '12 ene 2024',
  lastActivity: 'Hoy, 09:42',
};

const sessions = [
  { device: 'MacBook Pro', location: 'Madrid, ES', activity: 'Ahora', current: true, icon: Laptop },
  {
    device: 'iPhone 15',
    location: 'Madrid, ES',
    activity: 'Hace 2 h',
    current: false,
    icon: Smartphone,
  },
  {
    device: 'Chrome en Windows',
    location: 'Valencia, ES',
    activity: 'Hace 3 días',
    current: false,
    icon: Laptop,
  },
];

const events = [
  ['Hoy, 09:42', 'Inicio de sesión correcto', 'MacBook Pro · Madrid, ES'],
  ['Ayer, 16:18', 'Correo de acceso reenviado', 'Solicitado por administración'],
  ['18 jun, 11:05', 'Contraseña actualizada', 'Desde la cuenta del Reader'],
  ['02 jun, 08:30', 'Cuenta creada', 'Registro con correo y contraseña'],
] as const;

const sectionLinks = [
  ['Resumen', 'summary'],
  ['Datos de cuenta', 'account-data'],
  ['Acceso y seguridad', 'security'],
  ['Estado de cuenta', 'account-state'],
  ['Sesiones', 'sessions'],
  ['Actividad', 'activity'],
] as const;

function PrototypeAdministrators() {
  return null;
}

function PrototypeShell({ children }: { children: ReactNode }) {
  return (
    <CoreAdminContext
      authProvider={prototypeAuthProvider}
      dataProvider={prototypeDataProvider}
      i18nProvider={i18nProvider}
      store={memoryStore()}
    >
      <Resource
        name="administrators"
        list={PrototypeAdministrators}
        options={{ label: 'Administradores' }}
      />
      <Layout>{children}</Layout>
    </CoreAdminContext>
  );
}

function Status({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning';
}) {
  const styles = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function DetailSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-4 scroll-mt-20">
      <div>
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function FieldList({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 text-sm sm:grid-cols-[minmax(9rem,0.7fr)_1.4fr]">
      {children}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function ActionRow({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: typeof Mail;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t py-4 first:border-t-0 first:pt-0 last:pb-0">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      {children}
    </div>
  );
}

function ConfirmationNotice({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
      role="status"
    >
      <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <p className="flex-1 text-sm">{children}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar aviso"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function SocialUnlinkWarning({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="social-unlink-title"
      aria-describedby="social-unlink-description"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 id="social-unlink-title" className="font-semibold">
            Desvincular Google
          </h3>
          <p id="social-unlink-description" className="mt-1 text-sm text-muted-foreground">
            Es irreversible y puede dejar a María sin método de acceso. Confirma sólo si la persona
            tiene otra credencial.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="destructive" onClick={onConfirm}>
              Entiendo, desvincular
            </Button>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
              Cancelar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PrototypeRecordDetail() {
  const [notice, setNotice] = useState('');
  const [showUnlinkWarning, setShowUnlinkWarning] = useState(false);
  const action = (message: string, confirm = false) => {
    if (confirm && !window.confirm(`¿Confirmar ${message}?`)) return;
    setNotice(`Demo estática: ${message}. No se ha enviado ningún cambio.`);
  };
  return (
    <main
      className="users-detail mx-auto mb-8 max-w-6xl gap-6"
      aria-labelledby="prototype-reader-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/users"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Usuarios
        </Link>
        <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          PROTOTIPO · SOLO LECTURA
        </span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
            MG
          </div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              Reader · {reader.id}
            </p>
            <h1 id="prototype-reader-title" className="mt-1 text-2xl font-semibold tracking-tight">
              {reader.name}
            </h1>
            <p className="mt-1 break-words text-sm text-muted-foreground">{reader.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Status tone="success">
            <Check className="size-3" /> Activa
          </Status>
          <Button variant="ghost" size="icon" aria-label="Más acciones">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start" aria-label="Secciones de la cuenta">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Esta cuenta
          </p>
          <nav className="grid grid-cols-2 gap-1 lg:grid-cols-1">
            {sectionLinks.map(([label, id]) => (
              <a
                key={id}
                href={`#${id}`}
                className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {label}
              </a>
            ))}
          </nav>
          <Separator className="my-4" />
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Administración
          </p>
          <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <UsersRound className="size-4" /> Administradores
          </p>
          <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <Mail className="size-4" /> Invitaciones
          </p>
          <p className="mt-2 px-2 text-xs text-muted-foreground">
            Recursos separados de la cuenta del Reader.
          </p>
        </aside>

        <div className="min-w-0 space-y-8">
          <DetailSection
            id="summary"
            title="Resumen"
            description="Estado operativo y señales principales de esta cuenta."
          >
            <FieldList>
              <Field label="Estado">
                <Status tone="success">Activa</Status>
              </Field>
              <Field label="Alta">{reader.joined}</Field>
              <Field label="Última actividad">{reader.lastActivity}</Field>
              <Field label="Suscripción">Premium anual</Field>
              <Field label="Correo">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {reader.email}
                  <Status tone="success">Verificado</Status>
                </span>
              </Field>
              <Field label="Identificador">{reader.id}</Field>
            </FieldList>
          </DetailSection>

          <DetailSection
            id="account-data"
            title="Datos de cuenta"
            description="Campos de cuenta actuales, incluidos los datos personales opcionales."
          >
            <FieldList>
              <Field label="Nombre">María</Field>
              <Field label="Apellidos">García López</Field>
              <Field label="Fecha de nacimiento">14 de marzo de 1991</Field>
              <Field label="Teléfono">+34 612 445 890</Field>
              <Field label="Referencia de imagen">No configurada</Field>
              <Field label="Rol">{reader.role}</Field>
            </FieldList>
          </DetailSection>

          <DetailSection
            id="security"
            title="Acceso y seguridad"
            description="Credenciales, verificación y proveedores vinculados."
          >
            <div className="rounded-lg border bg-card p-4">
              <ActionRow
                icon={ShieldCheck}
                title="Correo de acceso"
                detail={`${reader.email} · verificado`}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    action('correo de acceso reenviado');
                  }}
                >
                  Reenviar
                </Button>
              </ActionRow>
              <ActionRow icon={Link2} title="Contraseña" detail="Actualizada hace 18 días">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    action('restablecimiento de contraseña preparado');
                  }}
                >
                  Restablecer
                </Button>
              </ActionRow>
              <ActionRow icon={Link2} title="Google" detail="Vinculado el 12 ene 2024">
                <Status>Proveedor vinculado</Status>
              </ActionRow>
            </div>
            {showUnlinkWarning ? (
              <SocialUnlinkWarning
                onCancel={() => {
                  setShowUnlinkWarning(false);
                }}
                onConfirm={() => {
                  setShowUnlinkWarning(false);
                  setNotice(
                    'Demo estática: proveedor Google desvinculado. No se ha enviado ningún cambio.',
                  );
                }}
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowUnlinkWarning(true);
                }}
              >
                Desvincular Google
              </Button>
            )}
          </DetailSection>

          <DetailSection
            id="account-state"
            title="Estado de cuenta"
            description="Controles de acceso y ciclo de vida, separados de los datos del perfil."
          >
            <div className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">La cuenta puede iniciar sesión</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Sin bloqueos ni solicitud de eliminación activa.
                  </p>
                </div>
                <Status tone="success">Sin restricciones</Status>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    action('deshabilitar cuenta', true);
                  }}
                >
                  Deshabilitar cuenta
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    action('solicitud de eliminación iniciada', true);
                  }}
                >
                  Solicitar eliminación
                </Button>
              </div>
            </div>
          </DetailSection>

          <DetailSection
            id="sessions"
            title="Sesiones"
            description="Dispositivos con una sesión activa para esta identidad."
          >
            <div className="rounded-lg border bg-card p-4">
              {sessions.map(({ device, location, activity, current, icon: Icon }) => (
                <ActionRow
                  key={device}
                  icon={Icon}
                  title={device}
                  detail={`${location} · ${activity}`}
                >
                  {current ? (
                    <Status tone="success">Este dispositivo</Status>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        action(`sesión revocada en ${device}`, true);
                      }}
                    >
                      Revocar
                    </Button>
                  )}
                </ActionRow>
              ))}
            </div>
          </DetailSection>

          <DetailSection
            id="activity"
            title="Actividad"
            description="Registro administrativo y de seguridad visible para el equipo."
          >
            <div className="rounded-lg border bg-card p-4">
              <ol className="space-y-4">
                {events.map(([date, title, detail]) => (
                  <li key={`${date}-${title}`} className="grid grid-cols-[auto_1fr] gap-3">
                    <span
                      className="mt-1.5 size-2 rounded-full bg-muted-foreground"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="text-xs text-muted-foreground">{date}</p>
                      <p className="mt-0.5 text-sm font-medium">{title}</p>
                      <p className="text-sm text-muted-foreground">{detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </DetailSection>

          <section
            aria-labelledby="danger-zone-title"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <h2 id="danger-zone-title" className="text-sm font-semibold">
                  Zona de peligro
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Las acciones irreversibles viven separadas del trabajo rutinario y siempre
                  explican su impacto.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
      {notice && (
        <ConfirmationNotice
          onClose={() => {
            setNotice('');
          }}
        >
          {notice}
        </ConfirmationNotice>
      )}
    </main>
  );
}

export function PrototypeAccountAdministration() {
  return (
    <PrototypeShell>
      <PrototypeRecordDetail />
    </PrototypeShell>
  );
}
