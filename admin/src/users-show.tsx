import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useGetOne } from 'ra-core';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import type { AdminReaderDetail } from './generated/contracts.js';
import {
  adminForceReaderEmailVerification,
  adminSetReaderAccess,
  adminReaderActivity,
  adminRequestReaderMessage,
  ApiError,
} from './api.js';
import { RecordField } from './kit/components/admin/record-field.js';
import { Show } from './kit/components/admin/show.js';
import { EmailChangeActions } from './email-change-actions.js';
import { DeletionRequestActions } from './deletion-request-actions.js';
import { SocialIdentityActions } from './social-identity-actions.js';
import { Button } from './kit/components/ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './kit/components/ui/tabs.js';

function DetailState({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-4 py-4" aria-labelledby="user-detail-title">
      <h1 id="user-detail-title" className="text-2xl font-bold tracking-tight">
        Detalle de usuario
      </h1>
      {children}
    </section>
  );
}

function listSearch(state: unknown): string {
  if (state === null || typeof state !== 'object' || !('fromList' in state)) return '';
  const value = state.fromList;
  return typeof value === 'string' && value.startsWith('?') && value.length <= 2048 ? value : '';
}

function BackToUsers({ search }: { search: string }) {
  return <Link to={{ pathname: '/users', search }}>Volver a la lista</Link>;
}

function Activity({ userId }: { userId: string }) {
  const activity = useInfiniteQuery({
    queryKey: ['admin-reader-activity', userId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => adminReaderActivity(userId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  if (activity.isPending) return <p role="status">Cargando actividad…</p>;
  if (activity.error !== null) {
    return (
      <div role="alert" className="space-y-3">
        <p>No pudimos cargar la actividad. Tu sesión se conserva.</p>
        <Button onClick={() => void activity.refetch()}>Reintentar</Button>
      </div>
    );
  }
  const events = activity.data.pages.flatMap((page) => page.items);
  if (events.length === 0) return <p>No hay actividad de ciclo de vida registrada.</p>;
  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {events.map((event) => (
          <li key={event.id} className="rounded-md border p-3">
            <strong>{event.type}</strong>
            <p className="text-muted-foreground">
              {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(event.occurredAt),
              )}
            </p>
          </li>
        ))}
      </ol>
      {activity.hasNextPage ? (
        <Button
          variant="outline"
          disabled={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          {activity.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
        </Button>
      ) : null}
    </div>
  );
}

type ReaderMessageKind = 'email-verification' | 'password-recovery';

function messageWorkflow(record: AdminReaderDetail, kind: ReaderMessageKind) {
  const type =
    kind === 'email-verification' ? 'email-verification-message' : 'password-recovery-message';
  return record.activeWorkflows.find((workflow) => workflow.type === type);
}

function cooldownSeconds(
  record: AdminReaderDetail,
  kind: ReaderMessageKind,
  now = Date.now(),
): number | null {
  const workflow = messageWorkflow(record, kind);
  if (workflow?.cooldownUntil === undefined) return null;
  const remaining = Date.parse(workflow.cooldownUntil) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return Math.ceil(remaining / 1000);
}

function messageWorkflowState(
  record: AdminReaderDetail,
  kind: ReaderMessageKind,
  now: number,
): string | null {
  const workflow = messageWorkflow(record, kind);
  if (workflow === undefined) return null;
  const remaining = cooldownSeconds(record, kind, now);
  if (workflow.state === 'scheduling-failed') {
    return 'El último envío no se pudo programar. Reintenta con el mismo intento.';
  }
  if (workflow.state === 'pending') {
    return remaining === null
      ? 'La programación está pendiente. Reintenta si persiste.'
      : `La programación está pendiente. Podrás reintentar en ${String(remaining)} s.`;
  }
  return remaining === null
    ? 'Correo programado.'
    : `Correo programado. Podrás reenviar en ${String(remaining)} s.`;
}

function AccessActions({ record, refresh }: { record: AdminReaderDetail; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [messageKeys, setMessageKeys] = useState<Partial<Record<ReaderMessageKind, string>>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const run = async (
    action: () => Promise<unknown>,
    success: string,
    handleError?: (error: unknown) => boolean,
  ) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setStatus(success);
      refresh();
      return true;
    } catch (error) {
      if (handleError?.(error) === true) return false;
      if (error instanceof ApiError && error.status === 429 && error.code === 'cooldown-active') {
        setStatus(
          `Espera ${String(error.retryAfterSeconds ?? 60)} segundos antes de volver a intentarlo.`,
        );
      } else if (
        error instanceof ApiError &&
        error.status === 412 &&
        error.code === 'stale-revision'
      ) {
        setStatus('El usuario cambió. Actualiza la página antes de reintentar.');
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'invalid-transition'
      ) {
        setStatus('El correo ya está verificado.');
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'no-usable-login-method'
      ) {
        setStatus('El usuario no tiene un método de acceso con contraseña.');
      } else {
        setStatus('No pudimos completar la acción. Inténtalo de nuevo.');
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const clearMessageKey = (kind: ReaderMessageKind, key: string) => {
    setMessageKeys((current) => {
      if (current[kind] !== key) return current;
      return { ...current, [kind]: undefined };
    });
  };
  const requestMessage = (kind: ReaderMessageKind, success: string) => {
    const key = messageKeys[kind] ?? crypto.randomUUID();
    setMessageKeys((current) => ({ ...current, [kind]: key }));
    void run(
      () => adminRequestReaderMessage(record.id, kind, key),
      success,
      (error) => {
        if (
          error instanceof ApiError &&
          error.status === 503 &&
          error.code === 'delivery-scheduling-failed'
        ) {
          setStatus(
            'No pudimos programar el envío. Reintenta con el mismo intento para evitar un duplicado.',
          );
          return true;
        }
        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
          setStatus(
            'No recibimos respuesta. Reintenta con el mismo intento para comprobar el resultado.',
          );
          return true;
        }
        clearMessageKey(kind, key);
        return false;
      },
    ).then((succeeded) => {
      if (succeeded) clearMessageKey(kind, key);
    });
  };
  const hasPassword = record.methods.some((method) => method.type === 'password');
  const deletionSuspended = record.deletionState !== null;
  const updateAccess = async (state: 'active' | 'disabled') => {
    setBusy(true);
    setStatus(null);
    try {
      await adminSetReaderAccess(record.id, state, record.revision);
      setStatus(state === 'disabled' ? 'Acceso deshabilitado.' : 'Acceso rehabilitado.');
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && error.code === 'stale-revision') {
        setStatus('El usuario cambió. Actualiza los datos antes de reintentar.');
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'active-deletion-request'
      ) {
        setStatus('El acceso no puede cambiar durante una solicitud de eliminación activa.');
      } else {
        setStatus('No pudimos cambiar el acceso. Inténtalo de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  };
  const verificationWorkflow = messageWorkflow(record, 'email-verification');
  const recoveryWorkflow = messageWorkflow(record, 'password-recovery');
  const verificationCooldown = cooldownSeconds(record, 'email-verification', now);
  const recoveryCooldown = cooldownSeconds(record, 'password-recovery', now);
  const verificationLocked =
    verificationWorkflow?.state !== 'scheduling-failed' && verificationCooldown !== null;
  const recoveryLocked =
    recoveryWorkflow?.state !== 'scheduling-failed' && recoveryCooldown !== null;
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="font-semibold">Estado de acceso</h3>
      <p>Estado de acceso: {record.access.state === 'active' ? 'Activo' : 'Deshabilitado'}</p>
      <p>
        Acceso efectivo:{' '}
        {record.access.effectiveState === 'active'
          ? 'Permitido'
          : record.access.effectiveState === 'suspended'
            ? 'Suspendido'
            : 'Bloqueado'}
      </p>
      <div className="flex flex-wrap gap-2">
        {record.access.state === 'active' ? (
          <Button
            variant="outline"
            disabled={busy || deletionSuspended}
            onClick={() => void updateAccess('disabled')}
          >
            Deshabilitar acceso
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy || deletionSuspended}
            onClick={() => void updateAccess('active')}
          >
            Rehabilitar acceso
          </Button>
        )}
      </div>
      {deletionSuspended ? (
        <p role="status">
          Los cambios de acceso están bloqueados mientras la solicitud esté activa.
        </p>
      ) : null}
      <h3 className="font-semibold">Acciones de correo</h3>
      <div className="flex flex-wrap gap-2">
        {!record.emailVerified ? (
          <Button
            disabled={busy || deletionSuspended}
            onClick={() =>
              void run(
                () => adminForceReaderEmailVerification(record.id, record.revision),
                'Correo marcado como verificado.',
              )
            }
          >
            Marcar correo como verificado
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={busy || deletionSuspended || record.emailVerified || verificationLocked}
          onClick={() => {
            requestMessage('email-verification', 'Correo de verificación programado.');
          }}
        >
          Reenviar verificación
        </Button>
        <Button
          variant="outline"
          disabled={busy || deletionSuspended || !hasPassword || recoveryLocked}
          onClick={() => {
            requestMessage('password-recovery', 'Correo de recuperación programado.');
          }}
        >
          Enviar recuperación
        </Button>
      </div>
      {!hasPassword ? (
        <p className="text-muted-foreground">
          La recuperación requiere un método de acceso con contraseña.
        </p>
      ) : null}
      {deletionSuspended ? (
        <p role="status">
          Las acciones de acceso y correo están bloqueadas durante la suspensión por eliminación.
        </p>
      ) : null}
      {verificationWorkflow !== undefined ? (
        <p role="status">{messageWorkflowState(record, 'email-verification', now)}</p>
      ) : null}
      {recoveryWorkflow !== undefined ? (
        <p role="status">{messageWorkflowState(record, 'password-recovery', now)}</p>
      ) : null}
      {status !== null ? <p role="status">{status}</p> : null}
    </div>
  );
}

export function UsersShow() {
  const { id } = useParams();
  const location = useLocation();
  const search = listSearch(location.state);
  const navigationState = search.length > 0 ? { fromList: search } : undefined;
  const validId = id !== undefined && id.length > 0 && id.length <= 128;
  const [activeTab, setActiveTab] = useState('summary');
  const [emailChangeTerminalState, setEmailChangeTerminalState] = useState<string | null>(null);
  const [socialIdentityStatus, setSocialIdentityStatus] = useState<string | null>(null);
  const query = useGetOne<AdminReaderDetail>(
    'users',
    { id: id ?? '' },
    { enabled: validId, retry: false, staleTime: 0 },
  );

  if (!validId) {
    return (
      <DetailState>
        <div role="alert">
          <h2>Solicitud inválida</h2>
          <p>Revisa el identificador del usuario.</p>
        </div>
        <BackToUsers search={search} />
      </DetailState>
    );
  }

  if (query.isPending || query.isFetching) {
    return (
      <DetailState>
        <p role="status">Cargando usuario…</p>
      </DetailState>
    );
  }

  if (query.error !== null) {
    if (query.error instanceof ApiError && query.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <DetailState>
          <div role="alert">
            <h2>Acceso denegado</h2>
            <p>Tu cuenta no tiene permiso para ver este usuario.</p>
          </div>
          <BackToUsers search={search} />
        </DetailState>
      );
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <DetailState>
          <div role="alert">
            <h2>Usuario no encontrado</h2>
            <p>No existe ningún usuario con este identificador.</p>
          </div>
          <BackToUsers search={search} />
        </DetailState>
      );
    }
    return (
      <DetailState>
        <div role="alert">
          <h2>No pudimos cargar el usuario</h2>
          <p>Tu sesión se conserva. Inténtalo de nuevo en unos instantes.</p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            Reintentar
          </Button>
        </div>
        <BackToUsers search={search} />
      </DetailState>
    );
  }

  return (
    <Show
      title="Detalle de usuario"
      actions={false}
      disableBreadcrumb
      queryOptions={{ enabled: false, initialData: query.data }}
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Tabs
          key={id}
          value={activeTab}
          onValueChange={(value) => {
            if (typeof value === 'string') {
              setActiveTab(value);
            }
          }}
          className="min-w-0 max-w-full overflow-hidden"
        >
          <div className="max-w-full overflow-x-auto">
            <TabsList variant="line" className="justify-start">
              <TabsTrigger value="summary">Resumen</TabsTrigger>
              <TabsTrigger value="access">Acceso</TabsTrigger>
              <TabsTrigger value="sessions">Sesiones</TabsTrigger>
              <TabsTrigger value="lifecycle">Ciclo de vida</TabsTrigger>
              <TabsTrigger value="activity">Actividad</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="summary" className="space-y-4 pt-4">
            <RecordField source="id" label="Identificador" />
            <RecordField source="email" label="Correo electrónico" />
            <RecordField
              label="Verificación"
              render={(record) =>
                record.emailVerified ? 'Correo verificado' : 'Correo sin verificar'
              }
            />
            <RecordField source="role" label="Rol" />
            <RecordField<AdminReaderDetail>
              label="Alta"
              render={(record) =>
                new Intl.DateTimeFormat('es').format(new Date(record.summary.createdAt))
              }
            />
          </TabsContent>
          <TabsContent value="access" className="space-y-4 pt-4">
            <AccessActions record={query.data} refresh={() => void query.refetch()} />
            <RecordField<AdminReaderDetail>
              label="Estado de acceso"
              render={(record) => (record.access.state === 'active' ? 'Activo' : 'Deshabilitado')}
            />
            <RecordField<AdminReaderDetail>
              label="Acceso efectivo"
              render={(record) =>
                record.access.effectiveState === 'active'
                  ? 'Permitido'
                  : record.access.effectiveState === 'suspended'
                    ? 'Suspendido'
                    : 'Bloqueado'
              }
            />
            <RecordField<AdminReaderDetail>
              label="Revisión"
              render={(record) => String(record.revision)}
            />
            <RecordField<AdminReaderDetail>
              label="Métodos de acceso"
              render={(record) =>
                record.methods.length === 0
                  ? 'Ninguno'
                  : record.methods
                      .map((method: AdminReaderDetail['methods'][number]) =>
                        method.type === 'password' ? 'Contraseña' : (method.provider ?? 'Social'),
                      )
                      .join(', ')
              }
            />
          </TabsContent>
          <TabsContent value="sessions" className="pt-4">
            <p>La consulta y gestión de sesiones estará disponible en una próxima entrega.</p>
          </TabsContent>
          <TabsContent value="lifecycle" className="space-y-3 pt-4">
            {query.data.activeWorkflows.length === 0 ? (
              <p>No hay procesos de ciclo de vida activos.</p>
            ) : (
              <ul>
                {query.data.activeWorkflows.map((workflow) => (
                  <li key={workflow.id}>{workflow.type}</li>
                ))}
              </ul>
            )}
            {emailChangeTerminalState !== null ? (
              <p role="status">
                Estado terminal de la solicitud anterior: {emailChangeTerminalState}.
              </p>
            ) : null}
            <p>Estado de eliminación: {query.data.deletionState ?? 'Sin solicitud activa'}</p>
            {socialIdentityStatus !== null ? <p role="status">{socialIdentityStatus}</p> : null}
            <SocialIdentityActions
              record={query.data}
              refresh={() => query.refetch()}
              onNoop={() => {
                setSocialIdentityStatus(
                  'Esta asociación ya no estaba vinculada; no se aplicó ningún cambio.',
                );
              }}
            />
            <DeletionRequestActions
              key={`deletion-${query.data.id}`}
              record={query.data}
              refresh={() => query.refetch()}
            />
            <EmailChangeActions
              key={query.data.id}
              record={query.data}
              refresh={() => query.refetch()}
              onTerminalState={setEmailChangeTerminalState}
            />
          </TabsContent>
          <TabsContent value="activity" className="pt-4">
            <Activity userId={id} />
          </TabsContent>
        </Tabs>
        <p>
          <Link to={`/users/${encodeURIComponent(id)}/edit`} state={navigationState}>
            Editar datos de cuenta
          </Link>
        </p>
        <p>
          <BackToUsers search={search} />
        </p>
      </div>
    </Show>
  );
}
