import { useGetOne } from 'ra-core';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import type { AdminUser } from './generated/contracts.js';
import { ApiError } from './api.js';
import { Button } from './kit/components/ui/button.js';

interface UsersLocationState {
  readonly fromList?: { readonly email: string; readonly page: number };
}

function backState(state: unknown): { readonly fromList?: { email: string; page: number } } {
  if (state !== null && typeof state === 'object' && 'fromList' in state) {
    const fromList = (state as UsersLocationState).fromList;
    if (
      fromList !== undefined &&
      typeof fromList.email === 'string' &&
      Number.isInteger(fromList.page) &&
      fromList.page >= 1
    ) {
      return { fromList: { email: fromList.email, page: fromList.page } };
    }
  }
  return {};
}

// Read-only administrative User detail (ticket #126, spec #123). The view
// resolves one opaque identifier through the established dataProvider
// (`getOne` over `GET /v1/admin/users/{userId}`) on the same-origin Worker,
// so direct navigation and reload load the same real detail as the list
// action. Only the exact safe projection (id, email, verification, role)
// is rendered with Spanish copy; loading, missing-User, retryable failure,
// anonymous and access-denied states stay distinct, and the back navigation
// preserves the practical list search/page state when it arrived from there.
export function UsersShow() {
  const { userId } = useParams();
  const location = useLocation();
  const back = backState(location.state);
  const { data, error, isFetching, refetch } = useGetOne<AdminUser>(
    'users',
    { id: userId ?? '' },
    {
      retry: false,
      staleTime: 0,
      enabled: userId !== undefined && userId.length > 0 && userId.length <= 128,
    },
  );

  if (userId === undefined || userId.length === 0 || userId.length > 128) {
    return (
      <section className="users-detail" aria-labelledby="user-detail-title">
        <h1 id="user-detail-title">Detalle de usuario</h1>
        <div role="alert">
          <h2>Solicitud inválida</h2>
          <p>Revisa el identificador del usuario.</p>
        </div>
        <p>
          <Link to="/users" state={back}>
            Volver a la lista
          </Link>
        </p>
      </section>
    );
  }

  if (isFetching) {
    return (
      <section className="users-detail" aria-labelledby="user-detail-title">
        <h1 id="user-detail-title">Detalle de usuario</h1>
        <p role="status">Cargando usuario…</p>
      </section>
    );
  }

  if (error !== null) {
    if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;
    if (error instanceof ApiError && error.status === 403) {
      return (
        <section className="users-detail" aria-labelledby="user-detail-title">
          <h1 id="user-detail-title">Detalle de usuario</h1>
          <div role="alert">
            <h2>Acceso denegado</h2>
            <p>Tu cuenta no tiene permiso para ver este usuario.</p>
          </div>
          <p>
            <Link to="/users" state={back}>
              Volver a la lista
            </Link>
          </p>
        </section>
      );
    }
    if (error instanceof ApiError && error.status === 404) {
      return (
        <section className="users-detail" aria-labelledby="user-detail-title">
          <h1 id="user-detail-title">Detalle de usuario</h1>
          <div role="alert">
            <h2>Usuario no encontrado</h2>
            <p>No existe ningún usuario con este identificador.</p>
          </div>
          <p>
            <Link to="/users" state={back}>
              Volver a la lista
            </Link>
          </p>
        </section>
      );
    }
    return (
      <section className="users-detail" aria-labelledby="user-detail-title">
        <h1 id="user-detail-title">Detalle de usuario</h1>
        <div role="alert">
          <h2>No pudimos cargar el usuario</h2>
          <p>Tu sesión se conserva. Inténtalo de nuevo en unos instantes.</p>
          <Button
            onClick={() => {
              void refetch();
            }}
          >
            Reintentar
          </Button>
        </div>
        <p>
          <Link to="/users" state={back}>
            Volver a la lista
          </Link>
        </p>
      </section>
    );
  }

  if (data === undefined) {
    return (
      <section className="users-detail" aria-labelledby="user-detail-title">
        <h1 id="user-detail-title">Detalle de usuario</h1>
        <p role="status">Cargando usuario…</p>
      </section>
    );
  }

  return (
    <section className="users-detail" aria-labelledby="user-detail-title">
      <h1 id="user-detail-title">Detalle de usuario</h1>
      <p className="auth-description">Consulta de solo lectura de esta cuenta.</p>
      <dl>
        <dt>Identificador</dt>
        <dd>{data.id}</dd>
        <dt>Correo electrónico</dt>
        <dd>{data.email}</dd>
        <dt>Verificación</dt>
        <dd>{data.emailVerified ? 'Correo verificado' : 'Correo sin verificar'}</dd>
        <dt>Rol</dt>
        <dd>{data.role}</dd>
      </dl>
      <p>
        <Link to="/users" state={back}>
          Volver a la lista
        </Link>
      </p>
    </section>
  );
}
