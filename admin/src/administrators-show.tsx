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
  const [messageKeys, setMessageKeys] = useState<Partial<Record<AdministratorMessageKind, string>>>(
    {},
  );
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
  const clearMessageKey = (kind: AdministratorMessageKind, key: string) => {
    setMessageKeys((current) =>
      current[kind] === key ? { ...current, [kind]: undefined } : current,
    );
  };
  const requestMessage = async (kind: AdministratorMessageKind) => {
    const key = messageKeys[kind] ?? crypto.randomUUID();
    setMessageKeys((current) => ({ ...current, [kind]: key }));
    setBusy(true);
    setStatus(null);
    try {
      const result = await adminRequestAdministratorMessage(record.id, kind, key);
      setMessageCooldowns((current) => ({ ...current, [kind]: result.cooldownUntil }));
      clearMessageKey(kind, key);
      setStatus(
        kind === 'email-verification'
          ? 'Correo de verificación programado.'
          : 'Correo de recuperación programado.',
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.code === 'cooldown-active') {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;
        setMessageCooldowns((current) => ({
          ...current,
          [kind]: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
        }));
        clearMessageKey(kind, key);
        setStatus(`Espera ${String(retryAfterSeconds)} segundos antes de volver a intentarlo.`);
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'invalid-transition'
      ) {
        clearMessageKey(kind, key);
        setStatus('El correo ya está verificado.');
      } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'no-usable-login-method'
      ) {
        clearMessageKey(kind, key);
        setStatus('El usuario no tiene un método de acceso con contraseña.');
      } else if (
        error instanceof ApiError &&
        error.status === 503 &&
        error.code === 'delivery-scheduling-failed'
      ) {
        setStatus('No pudimos programar el envío. Reintenta con el mismo intento.');
      } else if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
        setStatus(
          'No recibimos respuesta. Reintenta con el mismo intento para comprobar el resultado.',
        );
      } else {
        clearMessageKey(kind, key);
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
  const verificationCooldown = cooldownSeconds(messageCooldowns['email-verification'], now);
  const recoveryCooldown = cooldownSeconds(messageCooldowns['password-recovery'], now);
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || record.emailVerified || verificationCooldown !== null}
            onClick={() => void requestMessage('email-verification')}
          >
            Reenviar verificación
          </Button>
          <Button
            variant="outline"
            disabled={busy || !hasPassword || recoveryCooldown !== null}
            onClick={() => void requestMessage('password-recovery')}
          >
            Enviar recuperación
          </Button>
        </div>
        {!hasPassword ? (
          <p className="text-sm text-muted-foreground">
            La recuperación requiere un método de acceso con contraseña.
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
