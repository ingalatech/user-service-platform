import { useState, type SyntheticEvent } from 'react';
import { useGetList } from 'ra-core';
import { Link, useLocation } from 'react-router';
import type { AdminUser } from './generated/contracts.js';
import { ApiError } from './api.js';
import { Button } from './kit/components/ui/button.js';
import { Input } from './kit/components/ui/input.js';

const perPage = 10;

interface UsersLocationState {
  readonly fromList?: { readonly email: string; readonly page: number };
}

function initialQuery(state: unknown): { email: string; page: number } {
  if (state !== null && typeof state === 'object' && 'fromList' in state) {
    const fromList = (state as UsersLocationState).fromList;
    if (
      fromList !== undefined &&
      typeof fromList.email === 'string' &&
      Number.isInteger(fromList.page) &&
      fromList.page >= 1
    ) {
      return { email: fromList.email.slice(0, 254), page: fromList.page };
    }
  }
  return { email: '', page: 1 };
}

export function UsersList() {
  const location = useLocation();
  const [draft, setDraft] = useState(() => initialQuery(location.state).email);
  const [query, setQuery] = useState(() => initialQuery(location.state));
  const { data, total, error, isFetching, refetch } = useGetList<AdminUser>(
    'users',
    {
      pagination: { page: query.page, perPage },
      sort: { field: 'email', order: 'ASC' },
      filter: { email: query.email },
    },
    { retry: false, staleTime: 0 },
  );
  const pages = Math.max(1, Math.ceil((total ?? 0) / perPage));
  const applySearch = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery({ email: draft.trim(), page: 1 });
  };
  const clearSearch = () => {
    setDraft('');
    setQuery({ email: '', page: 1 });
  };

  return (
    <section className="users-list" aria-labelledby="users-title">
      <h1 id="users-title">Usuarios</h1>
      <p className="auth-description">Consulta las cuentas de este entorno.</p>
      <form role="search" className="users-search" onSubmit={applySearch}>
        <label htmlFor="user-email-search">Buscar por correo electrónico</label>
        <div className="users-search-controls">
          <Input
            id="user-email-search"
            type="search"
            maxLength={254}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <Button type="submit">Buscar</Button>
          <Button type="button" variant="outline" onClick={clearSearch}>
            Limpiar búsqueda
          </Button>
        </div>
      </form>
      {isFetching ? (
        <p role="status">Cargando usuarios…</p>
      ) : error !== null ? (
        <div role="alert">
          <p>
            {error instanceof ApiError && error.status === 403
              ? 'Acceso denegado'
              : 'No pudimos cargar los usuarios. Tu sesión se conserva.'}
          </p>
          <Button
            onClick={() => {
              void refetch();
            }}
          >
            Reintentar
          </Button>
        </div>
      ) : (
        <>
          <p role="status">
            {total ?? 0} {total === 1 ? 'usuario' : 'usuarios'} en total
          </p>
          {data === undefined || data.length === 0 ? (
            <div className="users-empty">
              <h2>Sin resultados</h2>
              <p>No hay usuarios que coincidan con esta búsqueda.</p>
            </div>
          ) : (
            <div className="users-table-scroll" tabIndex={0} aria-label="Listado de usuarios">
              <table>
                <caption className="sr-only">Usuarios de este entorno</caption>
                <thead>
                  <tr>
                    <th scope="col">Correo electrónico</th>
                    <th scope="col">Verificación</th>
                    <th scope="col">Rol</th>
                    <th scope="col">
                      <span className="sr-only">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>{user.emailVerified ? 'Correo verificado' : 'Correo sin verificar'}</td>
                      <td>{user.role}</td>
                      <td>
                        <Link
                          to={`/users/${encodeURIComponent(user.id)}`}
                          state={{ fromList: query }}
                          aria-label={`Ver detalle de ${user.email}`}
                        >
                          Ver detalle
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Paginación de usuarios" className="users-pagination">
            <Button
              variant="outline"
              disabled={query.page === 1}
              onClick={() => {
                setQuery({ ...query, page: query.page - 1 });
              }}
            >
              Anterior
            </Button>
            <span>
              Página {query.page} de {pages}
            </span>
            <Button
              variant="outline"
              disabled={query.page >= pages}
              onClick={() => {
                setQuery({ ...query, page: query.page + 1 });
              }}
            >
              Siguiente
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
