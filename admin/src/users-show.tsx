import { useGetOne } from 'ra-core';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import type { AdminUser } from './generated/contracts.js';
import { ApiError } from './api.js';
import { RecordField } from './kit/components/admin/record-field.js';
import { Show } from './kit/components/admin/show.js';
import { Button } from './kit/components/ui/button.js';
import { UserShowPrototype } from './prototype/user-show.js';

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

function BackToUsers() {
  return <Link to="/users">Volver a la lista</Link>;
}

export function UsersShow() {
  const { id } = useParams();
  const validId = id !== undefined && id.length > 0 && id.length <= 128;
  const query = useGetOne<AdminUser>(
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
        <BackToUsers />
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
          <BackToUsers />
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
          <BackToUsers />
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
        <BackToUsers />
      </DetailState>
    );
  }

  const canonicalDetail = (
    <div className="flex flex-col gap-4">
      <RecordField source="id" label="Identificador" />
      <RecordField source="email" label="Correo electrónico" />
      <RecordField
        label="Verificación"
        render={(record) => (record.emailVerified ? 'Correo verificado' : 'Correo sin verificar')}
      />
      <RecordField source="role" label="Rol" />
      <p>
        <Link to={`/users/${encodeURIComponent(id)}`}>Editar datos de cuenta</Link>
      </p>
    </div>
  );

  return (
    <Show
      title="Detalle de usuario"
      actions={false}
      queryOptions={{ enabled: false, initialData: query.data }}
    >
      {import.meta.env.DEV ? (
        <UserShowPrototype>{canonicalDetail}</UserShowPrototype>
      ) : (
        canonicalDetail
      )}
    </Show>
  );
}
