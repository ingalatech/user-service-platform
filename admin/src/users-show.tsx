import { useInfiniteQuery } from '@tanstack/react-query';
import { useGetOne } from 'ra-core';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import type { AdminReaderDetail } from './generated/contracts.js';
import { adminReaderActivity, ApiError } from './api.js';
import { RecordField } from './kit/components/admin/record-field.js';
import { Show } from './kit/components/admin/show.js';
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

export function UsersShow() {
  const { id } = useParams();
  const location = useLocation();
  const search = listSearch(location.state);
  const navigationState = search.length > 0 ? { fromList: search } : undefined;
  const validId = id !== undefined && id.length > 0 && id.length <= 128;
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
        <Tabs defaultValue="summary" className="min-w-0 max-w-full overflow-hidden">
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
