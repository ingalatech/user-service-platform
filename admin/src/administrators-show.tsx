import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useGetIdentity, useGetOne } from 'ra-core';
import { Link, Navigate, useParams } from 'react-router';
import type { AdminAdministratorDetail } from './generated/contracts.js';
import {
  adminAdministratorActivity,
  adminRequestAdministratorMessage,
  ApiError,
  setAdminAdministratorAccess,
} from './api.js';
import { Button } from './kit/components/ui/button.js';

type AdministratorMessageKind = 'email-verification' | 'password-recovery';
type AdministratorMessageCommand = Readonly<{
  targetId: string;
  kind: AdministratorMessageKind;
  key: string;
}>;

function messageCommandStorageKey(administratorId: string, kind: AdministratorMessageKind): string {
  return `admin-message-retry:${administratorId}:${kind}`;
}

function readMessageCommand(
  administratorId: string | undefined,
  kind: AdministratorMessageKind,
): AdministratorMessageCommand | undefined {
  if (administratorId === undefined) return undefined;
  try {
    const stored: unknown = JSON.parse(
      window.sessionStorage.getItem(messageCommandStorageKey(administratorId, kind)) ?? 'null',
    );
    if (
      typeof stored === 'object' &&
      stored !== null &&
      'targetId' in stored &&
      stored.targetId === administratorId &&
      'kind' in stored &&
      stored.kind === kind &&
      'key' in stored &&
      typeof stored.key === 'string' &&
      stored.key.length > 0 &&
      stored.key.length <= 128
    ) {
      return Object.freeze({ targetId: administratorId, kind, key: stored.key });
    }
  } catch {
    // Storage is optional; the command remains in component state while mounted.
  }
  return undefined;
}

function persistMessageCommand(command: AdministratorMessageCommand): void {
  try {
    window.sessionStorage.setItem(
      messageCommandStorageKey(command.targetId, command.kind),
      JSON.stringify(command),
    );
  } catch {
    // Storage is optional; the command remains in component state while mounted.
  }
}

function cooldownSeconds(until: string | undefined, now: number): number | null {
  if (until === undefined) return null;
  const remaining = Date.parse(until) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return Math.ceil(remaining / 1000);
}

export function AdministratorsShow() {
  const { id } = useParams();
  const validId = id !== undefined && id.length > 0 && id.length <= 128;
  const identity = useGetIdentity();
  const query = useGetOne<AdminAdministratorDetail>(
    'administrators',
    { id: id ?? '' },
    { enabled: validId, retry: false, staleTime: 0 },
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [messageCommands, setMessageCommands] = useState<
    Partial<Record<AdministratorMessageKind, AdministratorMessageCommand>>
  >(() => ({
    'email-verification': readMessageCommand(id, 'email-verification'),
    'password-recovery': readMessageCommand(id, 'password-recovery'),
  }));
  const [messageCooldowns, setMessageCooldowns] = useState<
    Partial<Record<AdministratorMessageKind, string>>
  >({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const activity = useInfiniteQuery({
    queryKey: ['admin-administrator-activity', id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => adminAdministratorActivity(id ?? '', pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: validId,
    retry: false,
  });
  if (!validId) return <Navigate to="/administrators" replace />;
  if (query.isPending || query.isFetching) return <p role="status">Cargando administrador…</p>;
  if (query.error !== null) {
    if (query.error instanceof ApiError && query.error.status === 401)
      return <Navigate to="/login" replace />;
    return (
      <div role="alert" className="space-y-3">
        <p>
          {query.error instanceof ApiError && query.error.status === 403
            ? 'Acceso denegado.'
            : 'No pudimos cargar el administrador. Tu sesión se conserva.'}
        </p>
        <Button onClick={() => void query.refetch()}>Reintentar</Button>
        <Link to="/administrators">Volver a administradores</Link>
      </div>
    );
  }
  const record = query.data;
  const isCurrent = identity.data?.id === record.id;
  const toggle = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const state = record.access.state === 'active' ? 'disabled' : 'active';
      await setAdminAdministratorAccess(record.id, state, record.revision);
      setStatus(
        state === 'active' ? 'Administrador rehabilitado.' : 'Administrador deshabilitado.',
      );
      await query.refetch();
    } catch (error) {
      setStatus(
        error instanceof ApiError && error.code === 'stale-revision'
          ? 'La cuenta cambió. Actualiza antes de reintentar.'
          : error instanceof ApiError && error.code === 'last-operational-administrator'
            ? 'Debe permanecer al menos un administrador operativo.'
            : 'No pudimos cambiar el acceso.',
      );
    } finally {
      setBusy(false);
    }
  };
  const clearMessageKey = (kind: AdministratorMessageKind, key: string, targetId: string) => {
    setMessageCommands((current) =>
      current[kind]?.key === key ? { ...current, [kind]: undefined } : current,
    );
    try {
      window.sessionStorage.removeItem(messageCommandStorageKey(targetId, kind));
    } catch {
      // Storage is optional.
    }
  };
  const requestMessage = async (kind: AdministratorMessageKind) => {
    const storedCommand = readMessageCommand(record.id, kind);
    const currentCommand = messageCommands[kind];
    const command =
      (currentCommand?.targetId === record.id ? currentCommand : storedCommand) ??
      Object.freeze({ targetId: record.id, kind, key: crypto.randomUUID() });
    setMessageCommands((current) => ({ ...current, [kind]: command }));
    persistMessageCommand(command);
    setBusy(true);
    setStatus(null);
    try {
      const result = await adminRequestAdministratorMessage(
        command.targetId,
        command.kind,
        command.key,
      );
      if (result.state === 'scheduled') {
        setMessageCooldowns((current) => ({ ...current, [kind]: result.cooldownUntil }));
      } else if (result.cooldownUntil !== undefined) {
        setMessageCooldowns((current) => ({ ...current, [kind]: result.cooldownUntil }));
      }
      clearMessageKey(kind, command.key, command.targetId);
      setStatus(
        result.state === 'verified'
          ? 'El correo ya estaba verificado; no se programó otro mensaje.'
          : kind === 'email-verification'
            ? 'Solicitud aceptada para programar el correo de verificación; la entrega no está confirmada.'
            : 'Solicitud aceptada para programar el correo de recuperación; la entrega no está confirmada.',
      );
      await query.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.code === 'cooldown-active') {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;
        setMessageCooldowns((current) => ({
          ...current,
          [kind]: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
        }));
        clearMessageKey(kind, command.key, command.targetId);
        setStatus(
          retryAfterSeconds === 1
            ? 'Espera 1 segundo antes de volver a intentarlo.'
            : `Espera ${String(retryAfterSeconds)} segundos antes de volver a intentarlo.`,
        );
        await query.refetch();
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'invalid-transition'
      ) {
        clearMessageKey(kind, command.key, command.targetId);
        setStatus('El correo ya está verificado.');
        await query.refetch();
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'no-usable-login-method'
      ) {
        clearMessageKey(kind, command.key, command.targetId);
        setStatus('El usuario no tiene un método de acceso con contraseña.');
        await query.refetch();
      } else if (
        error instanceof ApiError &&
        error.status === 503 &&
        error.code === 'delivery-scheduling-failed'
      ) {
        setStatus('Programación fallida. Reintenta con el mismo intento.');
        await query.refetch();
      } else if (error instanceof ApiError && error.status === 0) {
        setStatus(
          'No recibimos respuesta. Reintenta con el mismo intento para comprobar la programación.',
        );
        await query.refetch();
      } else if (error instanceof ApiError && error.status >= 500) {
        setStatus('No pudimos confirmar la programación. Reintenta con el mismo intento.');
        await query.refetch();
      } else {
        clearMessageKey(kind, command.key, command.targetId);
        setStatus('No pudimos completar la acción. Inténtalo de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  };
  const events = activity.data?.pages.flatMap((page) => page.items) ?? [];
  const retryActivity = () =>
    activity.hasNextPage ? activity.fetchNextPage() : activity.refetch();
  const hasPassword = record.methods.some((method) => method.type === 'password');
  const verificationWorkflow = record.messageWorkflows.emailVerification;
  const recoveryWorkflow = record.messageWorkflows.passwordRecovery;
  const hasVerificationRetry = messageCommands['email-verification']?.targetId === record.id;
  const hasRecoveryRetry = messageCommands['password-recovery']?.targetId === record.id;
  const verificationPending = verificationWorkflow?.state === 'pending';
  const recoveryPending = recoveryWorkflow?.state === 'pending';
  const verificationCooldown =
    Math.max(
      cooldownSeconds(verificationWorkflow?.cooldownUntil, now) ?? 0,
      cooldownSeconds(messageCooldowns['email-verification'], now) ?? 0,
    ) || null;
  const recoveryCooldown =
    Math.max(
      cooldownSeconds(recoveryWorkflow?.cooldownUntil, now) ?? 0,
      cooldownSeconds(messageCooldowns['password-recovery'], now) ?? 0,
    ) || null;
  return (
    <section className="space-y-6 py-4" aria-labelledby="administrator-detail-title">
      <div>
        <Link to="/administrators">Volver a la lista</Link>
        <h1 id="administrator-detail-title" className="text-2xl font-bold tracking-tight">
          Detalle de administrador
        </h1>
      </div>
      <dl className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Correo electrónico</dt>
          <dd>{record.email}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Estado</dt>
          <dd>{record.access.state === 'active' ? 'Activo' : 'Deshabilitado'}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Verificación</dt>
          <dd>{record.emailVerified ? 'Correo verificado' : 'Correo sin verificar'}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Métodos</dt>
          <dd>{record.methods.map((method) => method.type).join(', ') || 'Ninguno'}</dd>
        </div>
      </dl>
      {!isCurrent ? (
        <Button disabled={busy} onClick={() => void toggle()}>
          {record.access.state === 'active' ? 'Deshabilitar acceso' : 'Rehabilitar acceso'}
        </Button>
      ) : (
        <p>Esta es tu cuenta. La autodeshabilitación no está disponible.</p>
      )}
      {status !== null ? <p role="status">{status}</p> : null}
      <section
        className="space-y-3 rounded-md border p-4"
        aria-labelledby="administrator-email-actions-title"
      >
        <h2 id="administrator-email-actions-title" className="font-semibold">
          Acciones de correo
        </h2>
        <p className="text-sm text-muted-foreground">
          Las acciones solicitan programar un mensaje; no confirman su entrega. Completar estos
          flujos no rehabilita una cuenta deshabilitada ni restaura sesiones.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              busy ||
              record.emailVerified ||
              (verificationPending && !hasVerificationRetry) ||
              (verificationCooldown !== null && !hasVerificationRetry)
            }
            onClick={() => void requestMessage('email-verification')}
          >
            {hasVerificationRetry ? 'Reintentar verificación' : 'Reenviar verificación'}
          </Button>
          <Button
            variant="outline"
            disabled={
              busy ||
              !hasPassword ||
              (recoveryPending && !hasRecoveryRetry) ||
              (recoveryCooldown !== null && !hasRecoveryRetry)
            }
            onClick={() => void requestMessage('password-recovery')}
          >
            {hasRecoveryRetry ? 'Reintentar recuperación' : 'Enviar recuperación'}
          </Button>
        </div>
        {!hasPassword ? (
          <p className="text-sm text-muted-foreground">
            La recuperación requiere un método de acceso con contraseña.
          </p>
        ) : null}
        {verificationWorkflow !== null ? (
          <p role="status">
            Verificación:{' '}
            {verificationWorkflow.state === 'scheduled'
              ? 'mensaje aceptado para programación; entrega no confirmada.'
              : verificationWorkflow.state === 'pending'
                ? 'programación en curso; el resultado aún no está confirmado.'
                : 'la programación falló; el mensaje no está confirmado.'}
            {verificationWorkflow.lastScheduledAt !== null
              ? ` Última programación: ${new Intl.DateTimeFormat('es', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(verificationWorkflow.lastScheduledAt))}.`
              : ''}
          </p>
        ) : null}
        {recoveryWorkflow !== null ? (
          <p role="status">
            Recuperación:{' '}
            {recoveryWorkflow.state === 'scheduled'
              ? 'mensaje aceptado para programación; entrega no confirmada.'
              : recoveryWorkflow.state === 'pending'
                ? 'programación en curso; el resultado aún no está confirmado.'
                : 'la programación falló; el mensaje no está confirmado.'}
            {recoveryWorkflow.lastScheduledAt !== null
              ? ` Última programación: ${new Intl.DateTimeFormat('es', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(recoveryWorkflow.lastScheduledAt))}.`
              : ''}
          </p>
        ) : null}
        {verificationCooldown !== null ? (
          <p role="status">Podrás reenviar la verificación en {String(verificationCooldown)} s.</p>
        ) : null}
        {recoveryCooldown !== null ? (
          <p role="status">Podrás reenviar la recuperación en {String(recoveryCooldown)} s.</p>
        ) : null}
      </section>
      <section className="space-y-3" aria-labelledby="administrator-activity-title">
        <h2 id="administrator-activity-title" className="text-lg font-semibold">
          Actividad
        </h2>
        {activity.isPending ? (
          <p role="status">Cargando actividad…</p>
        ) : activity.error !== null && activity.data === undefined ? (
          <div role="alert" className="space-y-3">
            <p>No pudimos cargar la actividad.</p>
            <Button disabled={activity.isFetching} onClick={() => void activity.refetch()}>
              {activity.isFetching ? 'Cargando…' : 'Reintentar'}
            </Button>
          </div>
        ) : events.length === 0 && activity.error !== null ? (
          <div role="alert" className="space-y-3">
            <p>No pudimos cargar la actividad.</p>
            <Button disabled={activity.isFetching} onClick={() => void retryActivity()}>
              {activity.isFetching ? 'Cargando…' : 'Reintentar'}
            </Button>
          </div>
        ) : events.length === 0 ? (
          <p role="status">No hay actividad registrada.</p>
        ) : (
          <div className="space-y-3">
            <ol className="space-y-2">
              {events.map((event) => (
                <li key={event.id} className="rounded-md border p-3">
                  <strong>{event.type}</strong>
                  <p className="text-sm text-muted-foreground">
                    {new Intl.DateTimeFormat('es', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(event.occurredAt))}
                  </p>
                </li>
              ))}
            </ol>
            {activity.error !== null ? (
              <div role="alert" className="space-y-3">
                <p>No pudimos cargar más actividad.</p>
                <Button disabled={activity.isFetching} onClick={() => void retryActivity()}>
                  {activity.isFetching ? 'Cargando…' : 'Reintentar'}
                </Button>
              </div>
            ) : null}
            {activity.hasNextPage && activity.error === null ? (
              <Button
                variant="outline"
                disabled={activity.isFetchingNextPage}
                aria-busy={activity.isFetchingNextPage}
                onClick={() => void activity.fetchNextPage()}
              >
                {activity.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
              </Button>
            ) : null}
          </div>
        )}
      </section>
    </section>
  );
}
