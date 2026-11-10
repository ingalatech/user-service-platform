import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import type { SyntheticEvent } from 'react';
import { useState } from 'react';
import { useGetIdentity } from 'ra-core';
import { Link } from 'react-router';
import { AdminMeSchema } from './generated/contracts.js';
import type { AdminAuditEvent, AdminAuditEventsQuery } from './generated/contracts.js';
import { adminAdministratorDetail, adminAuditEvents, ApiError } from './api.js';
import { Button } from './kit/components/ui/button.js';
import { Input } from './kit/components/ui/input.js';

const PAGE_SIZE = 25;

interface AuditFilterDraft {
  readonly actorId: string;
  readonly action: string;
  readonly result: '' | 'success' | 'failure';
  readonly from: string;
  readonly to: string;
}

type AppliedAuditFilters = Omit<AdminAuditEventsQuery, 'limit' | 'cursor'>;

const EMPTY_FILTERS: AuditFilterDraft = {
  actorId: '',
  action: '',
  result: '',
  from: '',
  to: '',
};

function auditErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'No pudimos cargar la auditoría administrativa.';
  if (error.status === 401 && error.code === 'unauthenticated') {
    return 'La sesión terminó. Inicia sesión de nuevo para consultar la auditoría.';
  }
  if (error.status === 403 && error.code === 'administrator-disabled') {
    return 'La cuenta Administrator está deshabilitada.';
  }
  if (error.status === 403 && error.code === 'forbidden') {
    return 'No tienes permiso para consultar la auditoría administrativa.';
  }
  if (error.status === 400 && error.code === 'bad-request') {
    return 'Los filtros no son válidos. Revísalos e inténtalo de nuevo.';
  }
  if (error.status === 500 && error.code === 'internal-error') {
    return 'No pudimos completar la consulta. Tu sesión se conserva.';
  }
  return 'No pudimos cargar la auditoría administrativa. Tu sesión se conserva.';
}

function toIsoDateTime(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function AuditList() {
  const identity = AdminMeSchema.safeParse(useGetIdentity().data);
  const [draft, setDraft] = useState<AuditFilterDraft>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AppliedAuditFilters>({});
  const query = useInfiniteQuery({
    queryKey: ['admin-audit-events', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      adminAuditEvents(
        {
          limit: PAGE_SIZE,
          ...filters,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  const administratorIds = [
    ...new Set(
      events.flatMap((event) => [
        // Public/system invitation attempts carry no actor identifier. Never
        // borrow the current Administrator identity or synthesize a lookup id.
        ...(event.actor.realm === 'administrator' && event.actor.id !== undefined
          ? [event.actor.id]
          : []),
        ...(event.subject?.realm === 'administrator' ? [event.subject.id] : []),
      ]),
    ),
  ];
  const currentAdministratorId = identity.success ? identity.data.id : undefined;
  const lookupIds = administratorIds.filter((id) => id !== currentAdministratorId);
  const administratorLookups = useQueries({
    queries: lookupIds.map((administratorId) => ({
      queryKey: ['admin-audit-administrator', administratorId],
      queryFn: () => adminAdministratorDetail(administratorId),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const administratorLabel = (administratorId: string): string => {
    if (identity.success && administratorId === identity.data.id) return identity.data.email;
    const lookupIndex = lookupIds.indexOf(administratorId);
    const lookup = administratorLookups[lookupIndex];
    if (lookup?.data !== undefined) return lookup.data.email;
    if (lookup?.isPending) return 'Cargando Administrator…';
    return `Administrator (${administratorId})`;
  };
  const actorLabel = (actor: AdminAuditEvent['actor']): string => {
    if (actor.realm === 'anonymous') return 'Sistema público';
    if (actor.id === undefined) return 'Administrator sin identificador';
    return administratorLabel(actor.id);
  };
  const applyFilters = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const from = toIsoDateTime(draft.from);
    const to = toIsoDateTime(draft.to);
    setFilters({
      ...(draft.actorId.trim().length === 0 ? {} : { actorId: draft.actorId.trim() }),
      ...(draft.action.trim().length === 0 ? {} : { action: draft.action.trim() }),
      ...(draft.result === '' ? {} : { result: draft.result }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  };
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters({});
  };
  const retryAudit = () => (query.hasNextPage ? query.fetchNextPage() : query.refetch());
  const subjectLabel = (subject: (typeof events)[number]['subject']): string => {
    if (subject === null) return 'Sin sujeto';
    if (subject.realm === 'administrator') return administratorLabel(subject.id);
    return `Reader (${subject.id})`;
  };

  return (
    <section className="space-y-6 py-4" aria-labelledby="audit-title">
      <div>
        <h1 id="audit-title" className="text-2xl font-bold tracking-tight">
          Auditoría administrativa
        </h1>
        <p className="text-muted-foreground">
          Comandos autenticados registrados en el Event Ledger.
        </p>
      </div>
      <form
        className="grid gap-4 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-3"
        aria-label="Filtros de auditoría"
        onSubmit={applyFilters}
      >
        <label className="flex flex-col gap-1">
          <span>Administrator actor ID</span>
          <Input
            value={draft.actorId}
            maxLength={128}
            onChange={(event) => {
              setDraft((current) => ({ ...current, actorId: event.target.value }));
            }}
          />
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
          Los intentos públicos no tienen actor ID. Fíltralos por acción, por ejemplo
          administrator-invitation-attempt.
        </p>
        <label className="flex flex-col gap-1">
          <span>Acción (tipo exacto)</span>
          <Input
            value={draft.action}
            maxLength={128}
            placeholder="access-attempt"
            onChange={(event) => {
              setDraft((current) => ({ ...current, action: event.target.value }));
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Resultado</span>
          <select
            aria-label="Resultado"
            className="h-9 rounded-md border border-input bg-background px-2.5 text-sm"
            value={draft.result}
            onChange={(event) => {
              const result = event.target.value;
              if (result === '' || result === 'success' || result === 'failure') {
                setDraft((current) => ({ ...current, result }));
              }
            }}
          >
            <option value="">Todos</option>
            <option value="success">Éxito</option>
            <option value="failure">Fallo</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>Desde</span>
          <Input
            type="datetime-local"
            value={draft.from}
            onChange={(event) => {
              setDraft((current) => ({ ...current, from: event.target.value }));
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Hasta</span>
          <Input
            type="datetime-local"
            value={draft.to}
            onChange={(event) => {
              setDraft((current) => ({ ...current, to: event.target.value }));
            }}
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <Button type="submit">Aplicar filtros</Button>
          <Button type="button" variant="outline" onClick={clearFilters}>
            Limpiar filtros
          </Button>
        </div>
      </form>
      {query.isPending ? <p role="status">Cargando auditoría…</p> : null}
      {query.error !== null && query.data === undefined ? (
        <div role="alert" className="space-y-3">
          <p>{auditErrorMessage(query.error)}</p>
          <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? 'Cargando…' : 'Reintentar'}
          </Button>
          {query.error instanceof ApiError && query.error.status === 401 ? (
            <Link to="/login">Iniciar sesión</Link>
          ) : null}
        </div>
      ) : null}
      {query.error !== null && query.data !== undefined && events.length === 0 ? (
        <div role="alert" className="space-y-3">
          <p>{auditErrorMessage(query.error)}</p>
          <Button disabled={query.isFetching} onClick={() => void retryAudit()}>
            {query.isFetching ? 'Cargando…' : 'Reintentar'}
          </Button>
        </div>
      ) : null}
      {!query.isPending && query.error === null && events.length === 0 ? (
        query.hasNextPage ? (
          <div role="status" className="space-y-3">
            <p>No hay eventos visibles en esta página. Continúa para consultar los siguientes.</p>
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              aria-busy={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
            </Button>
          </div>
        ) : (
          <p role="status">No hay eventos de auditoría para estos filtros.</p>
        )
      ) : null}
      {events.length > 0 ? (
        <div className="space-y-4">
          <ol className="space-y-3" aria-label="Eventos de auditoría">
            {events.map((event) => (
              <li key={event.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold">
                    {event.type}{' '}
                    <span className="text-sm text-muted-foreground">v{String(event.version)}</span>
                  </h2>
                  <time className="text-sm text-muted-foreground" dateTime={event.occurredAt}>
                    {new Intl.DateTimeFormat('es', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(event.occurredAt))}
                  </time>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Actor</dt>
                    <dd className="break-all">
                      {event.actor.realm === 'anonymous' ? (
                        <span>
                          Sistema público{' '}
                          <span className="text-muted-foreground">(sin identificador)</span>
                        </span>
                      ) : (
                        actorLabel(event.actor)
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Sujeto</dt>
                    <dd className="break-all">{subjectLabel(event.subject)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Resultado</dt>
                    <dd>{event.result === 'success' ? 'Éxito' : 'Fallo'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Request ID</dt>
                    <dd className="break-all">{event.requestId}</dd>
                  </div>
                  {event.problemCode !== null ? (
                    <div>
                      <dt className="text-muted-foreground">Código de problema</dt>
                      <dd>{event.problemCode}</dd>
                    </div>
                  ) : null}
                  {event.metadata !== null ? (
                    <div>
                      <dt className="text-muted-foreground">Metadata segura</dt>
                      <dd className="break-all">
                        {Object.entries(event.metadata)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(' · ')}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            ))}
          </ol>
          {query.error !== null ? (
            <div role="alert" className="space-y-3">
              <p>{auditErrorMessage(query.error)}</p>
              <Button disabled={query.isFetching} onClick={() => void retryAudit()}>
                {query.isFetching ? 'Cargando…' : 'Reintentar'}
              </Button>
            </div>
          ) : null}
          {query.hasNextPage && query.error === null ? (
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              aria-busy={query.isFetchingNextPage}
              onClick={() => {
                void retryAudit();
              }}
            >
              {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
