import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type {
  AdminAdministratorInvitation,
  AdminAdministratorInvitationList,
  AuthConfig,
  PublicAdministratorInvitationInspect,
} from './generated/contracts.js';
import {
  acceptPublicAdministratorInvitation,
  adminAdministratorInvitations,
  cancelAdminAdministratorInvitation,
  createAdminAdministratorInvitation,
  inspectPublicAdministratorInvitation,
  ApiError,
  publicAuthConfig,
  resendAdminAdministratorInvitation,
} from './api.js';
import { Button } from './kit/components/ui/button.js';
import { Input } from './kit/components/ui/input.js';

type InvitationFilter = 'pending' | 'history';
type InvitationState = AdminAdministratorInvitation['state'];
type PersistedCommand = Readonly<{ key: string; email?: string; revision?: number }>;

const PAGE_SIZE = 10;
// The list contract accepts one state filter at a time, so terminal history is
// built from one correctly paginated query per terminal state. Merging the
// server-ordered results keeps counts, pages and the displayed set consistent.
const TERMINAL_STATES = ['accepted', 'cancelled', 'superseded', 'expired'] as const;

const createCommandStorageKey = 'admin-invitation:create';
const resendStorageKey = (id: string) => `admin-invitation:resend:${id}`;
const cancelStorageKey = (id: string) => `admin-invitation:cancel:${id}`;
const cooldownStorageKey = (id: string) => `admin-invitation:cooldown:${id}`;

// The token is captured and removed while this route module is evaluated,
// before React renders. Keep it in module memory only; never restore it from
// browser storage or expose it to the rendered tree.
const publicInvitationToken = (() => {
  const url = new URL(window.location.href);
  if (url.pathname !== '/admin/aceptar-invitacion') return null;
  const token = url.searchParams.get('token');
  if (token !== null) {
    url.searchParams.delete('token');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  return token;
})();
let publicInvitationInspection: Promise<PublicAdministratorInvitationInspect> | undefined;

function inspectInvitationOnce(token: string): Promise<PublicAdministratorInvitationInspect> {
  publicInvitationInspection ??= inspectPublicAdministratorInvitation(token);
  return publicInvitationInspection;
}

function readStoredCommand(key: string): PersistedCommand | undefined {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      'key' in value &&
      typeof value.key === 'string' &&
      value.key.length > 0 &&
      value.key.length <= 128
    ) {
      return Object.freeze({
        key: value.key,
        ...('email' in value && typeof value.email === 'string' ? { email: value.email } : {}),
        ...('revision' in value && typeof value.revision === 'number'
          ? { revision: value.revision }
          : {}),
      });
    }
  } catch {
    // Session storage is best-effort; command state remains in memory.
  }
  return undefined;
}

function persistCommand(key: string, command: PersistedCommand): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(command));
  } catch {
    // Session storage is best-effort; command state remains in memory.
  }
}

function clearStoredCommand(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Session storage is best-effort.
  }
}

function errorCopy(error: unknown, action: 'create' | 'resend' | 'cancel'): string {
  if (!(error instanceof ApiError)) return 'No pudimos completar la operación.';
  if (error.status === 503 && error.code === 'delivery-scheduling-failed') {
    return action === 'create'
      ? 'No pudimos confirmar la programación. La invitación queda pendiente; reintenta con el mismo intento.'
      : action === 'resend'
        ? 'No pudimos confirmar la programación. La invitación sigue pendiente; reintenta con el mismo intento.'
        : 'No pudimos confirmar la cancelación. Reintenta con el mismo intento.';
  }
  if (error.status === 0 || error.status >= 500) {
    return action === 'create'
      ? 'No pudimos confirmar la creación. Reintenta con el mismo intento.'
      : action === 'resend'
        ? 'No pudimos confirmar la programación. Reintenta con el mismo intento.'
        : 'No pudimos confirmar la cancelación. Reintenta con el mismo intento.';
  }
  if (error.status === 409 && error.code === 'email-conflict')
    return 'Ese correo ya está reservado o pertenece a un Administrator.';
  if (error.status === 409 && error.code === 'idempotency-key-reused')
    return 'La clave de este intento ya se usó con otros datos. Inicia una decisión nueva.';
  if (error.status === 409 && error.code === 'invalid-transition')
    return 'La invitación ya no está pendiente. Actualizamos su estado.';
  if (error.status === 412 && error.code === 'stale-revision')
    return 'La invitación cambió. Revisa el estado actualizado y decide de nuevo.';
  if (error.status === 428 && error.code === 'precondition-required')
    return 'Falta una precondición. Actualiza e inténtalo de nuevo.';
  if (error.status === 429 && error.code === 'cooldown-active')
    return `Espera ${String(error.retryAfterSeconds ?? 60)} segundos antes de reenviar.`;
  if (error.status === 404 && error.code === 'invitation-not-found')
    return 'No encontramos esta invitación. Actualizamos el listado.';
  if (error.status === 404 && error.code === 'administrator-not-found')
    return 'No encontramos esta invitación.';
  if (error.status === 400 && error.code === 'bad-request')
    return 'Revisa el correo electrónico e inténtalo de nuevo.';
  if (error.status === 403 && error.code === 'administrator-disabled')
    return 'Tu cuenta de Administrator está deshabilitada.';
  if (error.status === 403 && error.code === 'forbidden')
    return 'No tienes permiso para administrar invitaciones.';
  return 'No pudimos completar la operación.';
}

function cooldownRemaining(until: string | undefined, now: number): number {
  if (until === undefined) return 0;
  const parsed = Date.parse(until);
  return Number.isFinite(parsed) ? Math.max(0, Math.ceil((parsed - now) / 1000)) : 0;
}

// Fetch at least the first `needed` items for one terminal state. Each request
// is a normal server-paginated query; the loop only extends that state's
// window so a combined later page can be assembled without post-filtering a
// page that the server already paginated.
async function loadTerminalState(
  state: Exclude<InvitationState, 'pending'>,
  needed: number,
  signal?: AbortSignal,
): Promise<AdminAdministratorInvitationList> {
  const items: AdminAdministratorInvitation[] = [];
  let total: number | undefined;
  let offset = 0;
  for (;;) {
    const page = await adminAdministratorInvitations({ limit: 100, offset, state }, signal);
    total = page.total;
    items.push(...page.items);
    offset += page.items.length;
    if (items.length >= needed || page.items.length < 100 || offset >= page.total) break;
  }
  return { items: items.slice(0, needed), total };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
}

function invitationStateLabel(state: AdminAdministratorInvitation['state']): string {
  switch (state) {
    case 'pending':
      return 'Pendiente';
    case 'accepted':
      return 'Aceptada';
    case 'cancelled':
      return 'Cancelada';
    case 'superseded':
      return 'Reemplazada';
    case 'expired':
      return 'Vencida';
  }
}

export function AdministratorInvitations() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<InvitationFilter>('pending');
  const [page, setPage] = useState(0);
  const [email, setEmail] = useState(() => readStoredCommand(createCommandStorageKey)?.email ?? '');
  const [createCommand, setCreateCommand] = useState<PersistedCommand | undefined>(() =>
    readStoredCommand(createCommandStorageKey),
  );
  const [createBusy, setCreateBusy] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [resendCommands, setResendCommands] = useState<Record<string, PersistedCommand>>({});
  const [cancelCommands, setCancelCommands] = useState<Record<string, PersistedCommand>>({});
  const [cooldowns, setCooldowns] = useState<Record<string, string>>({});
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const pendingQuery = useQuery({
    queryKey: ['admin-administrator-invitations', 'pending', page],
    queryFn: ({ signal }) =>
      adminAdministratorInvitations(
        { limit: PAGE_SIZE, offset: page * PAGE_SIZE, state: 'pending' },
        signal,
      ),
    enabled: filter === 'pending',
    retry: false,
    staleTime: 0,
  });
  const terminalQueries = useQueries({
    queries: TERMINAL_STATES.map((state) => ({
      queryKey: ['admin-administrator-invitations', 'terminal', state, page],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        loadTerminalState(state, (page + 1) * PAGE_SIZE, signal),
      enabled: filter === 'history',
      retry: false,
      staleTime: 0,
    })),
  });
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const terminalLoaded = terminalQueries.every((query) => query.data !== undefined);
  const terminalTotal = terminalQueries.reduce(
    (total, query) => total + (query.data?.total ?? 0),
    0,
  );
  const terminalItems = useMemo(() => {
    return terminalQueries
      .flatMap((query) => query.data?.items ?? [])
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
  }, [terminalQueries]);
  const invitations = useMemo(() => {
    if (filter === 'pending') return pendingQuery.data?.items ?? [];
    const start = page * PAGE_SIZE;
    return terminalItems.slice(start, start + PAGE_SIZE);
  }, [filter, page, pendingQuery.data, terminalItems]);
  const total = filter === 'pending' ? (pendingQuery.data?.total ?? 0) : terminalTotal;
  const isPending =
    filter === 'pending'
      ? pendingQuery.isPending
      : terminalQueries.some((query) => query.isPending);
  const isFetching =
    filter === 'pending'
      ? pendingQuery.isFetching
      : terminalQueries.some((query) => query.isFetching);
  const loadError =
    filter === 'pending'
      ? pendingQuery.error
      : (terminalQueries.find((query) => query.error !== null)?.error ?? null);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  useEffect(() => {
    if (filter === 'pending' && pendingQuery.data === undefined) return;
    if (filter === 'history' && !terminalLoaded) return;
    if (page > lastPage) setPage(lastPage);
  }, [filter, lastPage, page, pendingQuery.data, terminalLoaded]);
  const refreshInvitations = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-administrator-invitations'] });
  };

  const submitCreate = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createBusy) return;
    const normalizedEmail = (createCommand?.email ?? email).trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setCreateStatus('Escribe un correo electrónico válido.');
      return;
    }
    const command =
      createCommand ?? Object.freeze({ key: crypto.randomUUID(), email: normalizedEmail });
    setCreateCommand(command);
    setEmail(command.email ?? normalizedEmail);
    persistCommand(createCommandStorageKey, command);
    setCreateBusy(true);
    setCreateStatus(null);
    try {
      await createAdminAdministratorInvitation(command.email ?? normalizedEmail, command.key);
      clearStoredCommand(createCommandStorageKey);
      setCreateCommand(undefined);
      setEmail('');
      setCreateStatus(
        'Invitación creada. La programación del correo quedó aceptada; la entrega no está confirmada.',
      );
      await refreshInvitations();
    } catch (error) {
      const uncertain = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!uncertain) {
        clearStoredCommand(createCommandStorageKey);
        setCreateCommand(undefined);
      }
      setCreateStatus(errorCopy(error, 'create'));
      // The authoritative pending list shows whether the reservation survived a
      // scheduling failure; the UI never infers a created or delivered email.
      await refreshInvitations();
    } finally {
      setCreateBusy(false);
    }
  };

  const resend = async (invitation: AdminAdministratorInvitation) => {
    if (rowBusyId !== null) return;
    const storageKey = resendStorageKey(invitation.id);
    const command =
      resendCommands[invitation.id] ??
      readStoredCommand(storageKey) ??
      Object.freeze({ key: crypto.randomUUID() });
    setResendCommands((current) => ({ ...current, [invitation.id]: command }));
    persistCommand(storageKey, command);
    setRowBusyId(invitation.id);
    setRowStatus(null);
    try {
      const result = await resendAdminAdministratorInvitation(invitation.id, command.key);
      clearStoredCommand(storageKey);
      setResendCommands((current) => {
        return withoutKey(current, invitation.id);
      });
      setCooldowns((current) => ({ ...current, [invitation.id]: result.cooldownUntil }));
      try {
        window.sessionStorage.setItem(cooldownStorageKey(invitation.id), result.cooldownUntil);
      } catch {
        // In-memory cooldown remains authoritative for this view.
      }
      setRowStatus('Reenvío aceptado para programación; la entrega no está confirmada.');
      await refreshInvitations();
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.code === 'cooldown-active') {
        clearStoredCommand(storageKey);
        setResendCommands((current) => {
          return withoutKey(current, invitation.id);
        });
        const until = new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000).toISOString();
        setCooldowns((current) => ({ ...current, [invitation.id]: until }));
        try {
          window.sessionStorage.setItem(cooldownStorageKey(invitation.id), until);
        } catch {
          // In-memory cooldown remains authoritative for this view.
        }
      } else if (
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === 'invitation-not-found'
      ) {
        // A vanished invitation cannot be retried with the same key; drop the
        // command and let the authoritative list remove the row.
        clearStoredCommand(storageKey);
        setResendCommands((current) => {
          return withoutKey(current, invitation.id);
        });
      }
      setRowStatus(errorCopy(error, 'resend'));
      await refreshInvitations();
    } finally {
      setRowBusyId(null);
    }
  };

  const cancel = async (invitation: AdminAdministratorInvitation) => {
    if (rowBusyId !== null) return;
    const storageKey = cancelStorageKey(invitation.id);
    const command =
      cancelCommands[invitation.id] ??
      readStoredCommand(storageKey) ??
      Object.freeze({ key: crypto.randomUUID(), revision: invitation.revision });
    setCancelCommands((current) => ({ ...current, [invitation.id]: command }));
    persistCommand(storageKey, command);
    setRowBusyId(invitation.id);
    setRowStatus(null);
    try {
      await cancelAdminAdministratorInvitation(
        invitation.id,
        command.revision ?? invitation.revision,
        command.key,
      );
      clearStoredCommand(storageKey);
      setCancelCommands((current) => {
        return withoutKey(current, invitation.id);
      });
      setConfirmCancelId(null);
      setRowStatus('Invitación cancelada.');
      await refreshInvitations();
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && error.code === 'stale-revision') {
        clearStoredCommand(storageKey);
        setCancelCommands((current) => {
          return withoutKey(current, invitation.id);
        });
        setConfirmCancelId(null);
      } else if (
        error instanceof ApiError &&
        (error.status === 409 || (error.status === 404 && error.code === 'invitation-not-found'))
      ) {
        clearStoredCommand(storageKey);
        setCancelCommands((current) => {
          return withoutKey(current, invitation.id);
        });
        setConfirmCancelId(null);
      }
      setRowStatus(errorCopy(error, 'cancel'));
      await refreshInvitations();
    } finally {
      setRowBusyId(null);
    }
  };

  return (
    <section
      className="space-y-5 rounded-lg border p-4"
      aria-labelledby="administrator-invitations-title"
    >
      <div>
        <h2 id="administrator-invitations-title" className="text-xl font-semibold">
          Invitaciones de Administrator
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Las invitaciones crean acceso sólo cuando la persona las acepta. Nunca se muestra el
          enlace ni se afirma entrega.
        </p>
      </div>

      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          void submitCreate(event);
        }}
      >
        <label className="grid gap-1 text-sm font-medium" htmlFor="administrator-invitation-email">
          Correo electrónico
          <Input
            id="administrator-invitation-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={email}
            disabled={createBusy || createCommand !== undefined}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
          />
        </label>
        <Button type="submit" disabled={createBusy} className="self-end">
          {createBusy
            ? 'Procesando…'
            : createCommand
              ? 'Reintentar programación'
              : 'Crear invitación'}
        </Button>
      </form>
      {createStatus !== null ? <p role="status">{createStatus}</p> : null}
      {createCommand !== undefined ? (
        <p className="text-sm text-muted-foreground" role="status">
          La invitación se muestra según el listado autoritativo. Si la programación del correo no
          se confirmó, permanece pendiente y se reintenta con el mismo intento.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2" aria-label="Filtrar invitaciones">
        <Button
          type="button"
          variant={filter === 'pending' ? 'default' : 'outline'}
          aria-pressed={filter === 'pending'}
          onClick={() => {
            setFilter('pending');
            setPage(0);
          }}
        >
          Pendientes
        </Button>
        <Button
          type="button"
          variant={filter === 'history' ? 'default' : 'outline'}
          aria-pressed={filter === 'history'}
          onClick={() => {
            setFilter('history');
            setPage(0);
          }}
        >
          Historial terminal
        </Button>
      </div>

      {isPending || isFetching ? (
        <p role="status">Cargando invitaciones…</p>
      ) : loadError !== null ? (
        <div role="alert" className="space-y-2">
          <p>{errorCopy(loadError, 'create')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refreshInvitations();
            }}
          >
            Reintentar carga
          </Button>
        </div>
      ) : invitations.length === 0 ? (
        <p role="status">
          {filter === 'pending' ? 'No hay invitaciones pendientes.' : 'No hay historial terminal.'}
        </p>
      ) : (
        <ul className="grid gap-3" aria-label="Invitaciones">
          {invitations.map((invitation) => {
            let storedCooldown: string | undefined;
            try {
              storedCooldown =
                window.sessionStorage.getItem(cooldownStorageKey(invitation.id)) ?? undefined;
            } catch {
              storedCooldown = undefined;
            }
            const cooldownUntil = cooldowns[invitation.id] ?? storedCooldown;
            const remaining = cooldownRemaining(cooldownUntil, now);
            const retrying =
              resendCommands[invitation.id] !== undefined ||
              readStoredCommand(resendStorageKey(invitation.id)) !== undefined;
            const cancelRetry =
              cancelCommands[invitation.id] ?? readStoredCommand(cancelStorageKey(invitation.id));
            return (
              <li key={invitation.id} className="grid gap-3 rounded-md border p-3 sm:p-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="break-all font-medium">{invitation.email}</p>
                    <p className="text-sm text-muted-foreground">
                      {invitationStateLabel(invitation.state)}
                    </p>
                    {invitation.state === 'pending' ? (
                      <p className="text-sm text-muted-foreground">
                        {createCommand?.email === invitation.email
                          ? 'Programación del correo sin confirmar; reintenta con el mismo intento.'
                          : 'La entrega del correo no está confirmada.'}
                      </p>
                    ) : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:justify-self-end">
                    <dt className="text-muted-foreground">Vence</dt>
                    <dd>
                      {new Intl.DateTimeFormat('es', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(invitation.expiresAt))}
                    </dd>
                    <dt className="text-muted-foreground">Creada</dt>
                    <dd>
                      {new Intl.DateTimeFormat('es', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(invitation.createdAt))}
                    </dd>
                    <dt className="text-muted-foreground">Revisión</dt>
                    <dd>{invitation.revision}</dd>
                  </dl>
                </div>
                {invitation.state === 'pending' ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={rowBusyId !== null || (remaining > 0 && !retrying)}
                      onClick={() => {
                        void resend(invitation);
                      }}
                    >
                      {rowBusyId === invitation.id
                        ? 'Procesando…'
                        : retrying
                          ? 'Reintentar reenvío'
                          : 'Reenviar invitación'}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={rowBusyId !== null}
                      onClick={() => {
                        setConfirmCancelId(invitation.id);
                        setRowStatus(null);
                      }}
                    >
                      Cancelar
                    </Button>
                    {remaining > 0 ? (
                      <p role="status" className="self-center text-sm">
                        Reenvío disponible en {remaining} s.
                      </p>
                    ) : null}
                    {cancelRetry !== undefined ? (
                      <p className="self-center text-sm">
                        Hay una cancelación sin confirmar para reintentar.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {confirmCancelId === invitation.id ? (
                  <div
                    role="alertdialog"
                    aria-labelledby={`cancel-invitation-${invitation.id}`}
                    className="grid gap-2 rounded-md border p-3"
                  >
                    <p id={`cancel-invitation-${invitation.id}`} className="font-medium">
                      ¿Cancelar la invitación para {invitation.email}?
                    </p>
                    <p className="text-sm text-muted-foreground">
                      El enlace dejará de ser válido y el correo se liberará para otra invitación.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={rowBusyId !== null}
                        onClick={() => {
                          void cancel(invitation);
                        }}
                      >
                        {rowBusyId === invitation.id ? 'Cancelando…' : 'Confirmar cancelación'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={rowBusyId !== null}
                        onClick={() => {
                          setConfirmCancelId(null);
                        }}
                      >
                        Volver
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {rowStatus !== null ? <p role="status">{rowStatus}</p> : null}
      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p role="status">{total} invitaciones encontradas</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={page === 0 || isFetching}
              onClick={() => {
                setPage((current) => Math.max(0, current - 1));
              }}
            >
              Anterior
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={(page + 1) * PAGE_SIZE >= total || isFetching}
              onClick={() => {
                setPage((current) => current + 1);
              }}
            >
              Siguiente
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type PublicInvitationState = PublicAdministratorInvitationInspect | null;

function passwordRequirements(password: string, policy: AuthConfig['passwordPolicy']): boolean {
  const points = Array.from(password);
  const count = (pattern: RegExp) => points.filter((point) => pattern.test(point)).length;
  return (
    points.length >= policy.minLength &&
    points.length <= policy.maxLength &&
    count(/\p{Lu}/u) >= policy.minUppercase &&
    count(/\p{Ll}/u) >= policy.minLowercase &&
    count(/\p{Nd}/u) >= policy.minDigits &&
    count(/[^\p{L}\p{N}\s]/u) >= policy.minSymbols
  );
}

function publicInvitationMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'No pudimos validar la invitación. Inténtalo de nuevo.';
  if (error.status === 404 && error.code === 'verification-invalid')
    return 'La invitación no está disponible o no es válida.';
  if (error.status === 409 && error.code === 'email-conflict')
    return 'No se puede completar esta invitación. Solicita una nueva invitación al equipo de administración.';
  if (error.status === 400 && error.code === 'bad-request')
    return 'Revisa el nombre y los requisitos de contraseña.';
  if (error.status === 403 && error.code === 'email-password-disabled')
    return 'La aceptación de invitaciones no está disponible en este momento.';
  if (error.status >= 500 || error.status === 0)
    return 'No pudimos completar la operación. Inténtalo de nuevo.';
  return 'No pudimos validar la invitación. Inténtalo de nuevo.';
}

export function AcceptAdministratorInvitation() {
  const navigate = useNavigate();
  const invitationToken = publicInvitationToken;
  const [invitation, setInvitation] = useState<PublicInvitationState>(null);
  const [policy, setPolicy] = useState<AuthConfig['passwordPolicy'] | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const inspect = async () => {
      if (invitationToken === null) {
        setStatus('La invitación no está disponible o no es válida.');
        setLoading(false);
        return;
      }
      try {
        const result = await inspectInvitationOnce(invitationToken);
        if (!active) return;
        setInvitation(result);
        if (result.state === 'pending') {
          try {
            const config = await publicAuthConfig();
            setPolicy(config.passwordPolicy);
          } catch {
            setStatus('No pudimos cargar los requisitos actuales de contraseña.');
          }
        }
      } catch (error) {
        if (active) setStatus(publicInvitationMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    };
    void inspect();
    return () => {
      active = false;
    };
  }, [invitationToken]);

  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || invitationToken === null || policy === null) return;
    if (displayName.trim().length === 0 || displayName.trim().length > 200) {
      setStatus('Escribe un nombre de 1 a 200 caracteres.');
      return;
    }
    if (!passwordRequirements(password, policy)) {
      setStatus('La contraseña no cumple los requisitos actuales.');
      return;
    }
    if (password !== confirmation) {
      setStatus('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await acceptPublicAdministratorInvitation({
        token: invitationToken,
        name: displayName.trim(),
        password,
        passwordConfirmation: confirmation,
      });
      setAccepted(true);
      setInvitation(null);
      setDisplayName('');
      setPassword('');
      setConfirmation('');
      setStatus('Invitación aceptada. Ya puedes iniciar sesión con tu cuenta de Administrator.');
    } catch (error) {
      setStatus(publicInvitationMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <section
        className="auth-card space-y-4"
        aria-labelledby="accept-administrator-invitation-title"
      >
        <p className="eyebrow">ADMINISTRACIÓN</p>
        <h1 id="accept-administrator-invitation-title">Aceptar invitación</h1>
        {loading ? <p role="status">Comprobando invitación…</p> : null}
        {invitation !== null ? (
          <div className="space-y-2">
            <p>
              Correo: <strong>{invitation.email}</strong>
            </p>
            <p>Estado: {invitationStateLabel(invitation.state)}</p>
            <p>
              Vence:{' '}
              {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(invitation.expiresAt),
              )}
            </p>
            {invitation.state === 'pending' && !accepted ? (
              policy === null ? (
                <p role="status">Cargando los requisitos de contraseña…</p>
              ) : (
                <form
                  className="grid gap-3"
                  onSubmit={(event) => {
                    void submit(event);
                  }}
                >
                  <label
                    className="grid gap-1 text-sm font-medium"
                    htmlFor="invited-administrator-name"
                  >
                    Nombre visible
                    <Input
                      id="invited-administrator-name"
                      autoComplete="name"
                      maxLength={200}
                      required
                      value={displayName}
                      disabled={busy}
                      onChange={(event) => {
                        setDisplayName(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <label
                    className="grid gap-1 text-sm font-medium"
                    htmlFor="invited-administrator-password"
                  >
                    Contraseña
                    <Input
                      id="invited-administrator-password"
                      type="password"
                      autoComplete="new-password"
                      maxLength={policy.maxLength}
                      required
                      value={password}
                      disabled={busy}
                      onChange={(event) => {
                        setPassword(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <label
                    className="grid gap-1 text-sm font-medium"
                    htmlFor="invited-administrator-confirm-password"
                  >
                    Confirmar contraseña
                    <Input
                      id="invited-administrator-confirm-password"
                      type="password"
                      autoComplete="new-password"
                      maxLength={128}
                      required
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => {
                        setConfirmation(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <div
                    className="text-sm text-muted-foreground"
                    aria-label="Requisitos de contraseña"
                  >
                    <p>Requisitos actuales:</p>
                    <ul className="list-disc pl-5">
                      <li>
                        {policy.minLength}–{policy.maxLength} caracteres
                      </li>
                      {policy.minUppercase > 0 ? <li>{policy.minUppercase} mayúscula(s)</li> : null}
                      {policy.minLowercase > 0 ? <li>{policy.minLowercase} minúscula(s)</li> : null}
                      {policy.minDigits > 0 ? <li>{policy.minDigits} dígito(s)</li> : null}
                      {policy.minSymbols > 0 ? <li>{policy.minSymbols} símbolo(s)</li> : null}
                    </ul>
                  </div>
                  <Button type="submit" disabled={busy}>
                    {busy ? 'Aceptando…' : 'Aceptar invitación'}
                  </Button>
                </form>
              )
            ) : null}
            {invitation.state !== 'pending' ? (
              <>
                <p role="status">
                  Esta invitación ya no se puede aceptar. Contacta al equipo de administración si
                  necesitas acceso.
                </p>
                <Link to="/login" className="underline">
                  Ir al inicio de sesión de Administrator
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
        {status !== null ? <p role="status">{status}</p> : null}
        {accepted ? (
          <Button
            type="button"
            onClick={() => {
              void navigate('/login', { replace: true });
            }}
          >
            Ir al inicio de sesión
          </Button>
        ) : null}
        {!loading && invitation === null && !accepted ? (
          <Link to="/login" className="underline">
            Volver al inicio de sesión
          </Link>
        ) : null}
      </section>
    </main>
  );
}
