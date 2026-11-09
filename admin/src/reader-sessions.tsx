import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminReaderSessions } from './generated/contracts.js';
import {
  adminReaderSessions,
  adminRevokeAllReaderSessions,
  adminRevokeReaderSession,
  ApiError,
} from './api.js';
import { Button } from './kit/components/ui/button.js';

type Session = AdminReaderSessions['items'][number];

type RevokeCommand =
  | Readonly<{ kind: 'one'; readerId: string; selector: string }>
  | Readonly<{ kind: 'all'; readerId: string }>;

type Confirmation = Readonly<{ kind: 'one'; selector: string }> | Readonly<{ kind: 'all' }>;

function shortSelector(selector: string): string {
  return `${selector.slice(0, 7)}…${selector.slice(-4)}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404 && error.code === 'reader-not-found') {
      return 'No se encontró el Reader.';
    }
    if (error.status === 401 && error.code === 'unauthenticated') {
      return 'La sesión administrativa terminó. Inicia sesión de nuevo.';
    }
    if (error.status === 403 && error.code === 'administrator-disabled') {
      return 'La cuenta de administración está deshabilitada.';
    }
    if (error.status === 403 && error.code === 'forbidden') {
      return 'Tu cuenta no tiene permiso para administrar estas sesiones.';
    }
  }
  return 'No pudimos completar la operación de sesiones. Inténtalo de nuevo.';
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

function SessionRow({
  session,
  disabled,
  onRevoke,
}: {
  session: Session;
  disabled: boolean;
  onRevoke: (session: Session) => void;
}) {
  const format = (value: string) =>
    new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const abbreviatedSelector = shortSelector(session.selector);

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
      <dl className="grid min-w-0 flex-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Selector opaco</dt>
          <dd className="font-mono">{abbreviatedSelector}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Creada</dt>
          <dd>{format(session.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Última actualización</dt>
          <dd>{format(session.updatedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expira</dt>
          <dd>{format(session.expiresAt)}</dd>
        </div>
      </dl>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-label={`Revocar sesión ${abbreviatedSelector}`}
        onClick={() => {
          onRevoke(session);
        }}
      >
        Revocar sesión
      </Button>
    </li>
  );
}

export function ReaderSessions({
  readerId,
  refreshReader,
  onMutationStatus,
}: {
  readerId: string;
  refreshReader: () => Promise<void>;
  onMutationStatus: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pendingCommand, setPendingCommand] = useState<RevokeCommand | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['admin-reader-sessions', readerId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => adminReaderSessions(readerId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });

  const refreshAuthoritativeState = async () => {
    const [sessionsResult] = await Promise.all([query.refetch(), refreshReader()]);
    if (sessionsResult.isError) throw new Error('Session refresh failed.');
  };

  const execute = async (command: RevokeCommand) => {
    setBusy(true);
    onMutationStatus(null);
    try {
      const result =
        command.kind === 'all'
          ? await adminRevokeAllReaderSessions(command.readerId)
          : await adminRevokeReaderSession(command.readerId, command.selector);
      setConfirmation(null);
      setPendingCommand(null);
      try {
        await refreshAuthoritativeState();
        const message = result.changed
          ? command.kind === 'all'
            ? 'Se revocaron las sesiones activas. El Reader podrá iniciar sesión de nuevo si el acceso lo permite.'
            : 'La sesión se revocó. El Reader podrá iniciar sesión de nuevo si el acceso lo permite.'
          : command.kind === 'all'
            ? 'No había sesiones activas que revocar; el estado se actualizó.'
            : 'La sesión ya no estaba activa; el estado se actualizó.';
        onMutationStatus(message);
      } catch {
        const message =
          'La revocación fue confirmada, pero no pudimos actualizar la vista. Vuelve a cargarla.';
        onMutationStatus(message);
      }
    } catch (error) {
      setConfirmation(null);
      onMutationStatus(
        isRetryable(error)
          ? 'No recibimos una respuesta definitiva. Reintenta la misma revocación para comprobar el resultado.'
          : safeErrorMessage(error),
      );
      if (isRetryable(error)) setPendingCommand(command);
      else setPendingCommand(null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (pendingCommand !== null) {
      void execute(pendingCommand);
      return;
    }
    if (confirmation === null) return;
    const command: RevokeCommand = Object.freeze(
      confirmation.kind === 'all'
        ? { kind: 'all', readerId }
        : { kind: 'one', readerId, selector: confirmation.selector },
    );
    void execute(command);
  };

  const sessions = query.data?.pages.flatMap((page) => page.items) ?? [];
  const activeCount = query.data?.pages[0]?.total ?? 0;
  const actionsUnavailable = busy || query.data === undefined || activeCount === 0;

  return (
    <section className="space-y-4" aria-labelledby="reader-sessions-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="reader-sessions-title" className="text-lg font-semibold">
            Sesiones Reader
          </h2>
          {query.data !== undefined ? (
            <p className="text-sm text-muted-foreground">
              {String(activeCount)} {activeCount === 1 ? 'sesión activa' : 'sesiones activas'}
            </p>
          ) : null}
        </div>
        {pendingCommand === null ? (
          <Button
            type="button"
            variant="destructive"
            disabled={actionsUnavailable}
            onClick={() => {
              setConfirmation({ kind: 'all' });
            }}
          >
            Revocar todas las sesiones
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={actionsUnavailable}
            onClick={() => {
              setConfirmation(
                pendingCommand.kind === 'all'
                  ? { kind: 'all' }
                  : { kind: 'one', selector: pendingCommand.selector },
              );
            }}
          >
            {busy ? 'Comprobando…' : 'Reintentar revocación pendiente'}
          </Button>
        )}
      </div>

      {query.isPending ? <p role="status">Cargando sesiones…</p> : null}
      {query.error !== null && query.data === undefined ? (
        <div role="alert" className="space-y-3">
          <p>No pudimos cargar las sesiones. Tu sesión administrativa se conserva.</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      {query.error !== null && query.data !== undefined && !query.isFetchNextPageError ? (
        <div role="alert" className="space-y-2">
          <p>No pudimos actualizar las sesiones; se conserva la última vista cargada.</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      {query.data !== undefined && sessions.length === 0 ? (
        <p>No hay sesiones Reader activas.</p>
      ) : null}
      {sessions.length > 0 ? (
        <ul className="space-y-3">
          {sessions.map((session) => (
            <SessionRow
              key={session.selector}
              session={session}
              disabled={actionsUnavailable || pendingCommand !== null}
              onRevoke={(selected) => {
                setConfirmation({ kind: 'one', selector: selected.selector });
              }}
            />
          ))}
        </ul>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetchingNextPage || busy || pendingCommand !== null}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más sesiones'}
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <p role="alert">No pudimos cargar más sesiones. Inténtalo de nuevo.</p>
      ) : null}
      {confirmation !== null ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reader-session-confirm-title"
          aria-describedby="reader-session-confirm-description"
          className="space-y-3 rounded-md border p-4"
        >
          <h3 id="reader-session-confirm-title" className="font-semibold">
            Confirmar revocación de sesión
          </h3>
          <p id="reader-session-confirm-description">
            {confirmation.kind === 'all'
              ? 'Se revocarán todas las sesiones activas del Reader.'
              : `Se revocará solo la sesión ${shortSelector(confirmation.selector)}.`}{' '}
            No cambiará el acceso ni las credenciales; el Reader podrá iniciar sesión de nuevo si el
            acceso lo permite.
            {pendingCommand !== null
              ? ' Se repetirá exactamente la misma revocación pendiente.'
              : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" autoFocus disabled={busy} onClick={confirm}>
              {pendingCommand === null ? 'Confirmar revocación' : 'Confirmar reintento'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
