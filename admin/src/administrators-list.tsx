import { useListContext } from 'ra-core';
import type { ComponentProps, ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import type { AdminAdministrator } from './generated/contracts.js';
import { ApiError } from './api.js';
import { List } from './kit/components/admin/list.js';
import { ListPagination } from './kit/components/admin/list-pagination.js';
import { SearchInput } from './kit/components/admin/search-input.js';
import { Button, buttonVariants } from './kit/components/ui/button.js';
import { AdministratorInvitations } from './administrator-invitations.js';

const perPage = 10;

function EmailSearchInput(props: ComponentProps<typeof SearchInput>) {
  return (
    <label className="flex flex-col gap-1">
      <span>Buscar por correo electrónico</span>
      <SearchInput {...props} aria-label="Buscar por correo electrónico" />
    </label>
  );
}

const filters: ReactElement[] = [
  <EmailSearchInput key="email" source="email" alwaysOn maxLength={254} />,
];

function AdministratorGroup({ title, records }: { title: string; records: AdminAdministrator[] }) {
  const location = useLocation();
  return (
    <section className="space-y-3" aria-labelledby={`administrator-${title}`}>
      <h2 id={`administrator-${title}`} className="text-lg font-semibold">
        {title}
      </h2>
      {records.length === 0 ? (
        <p className="text-muted-foreground">No hay cuentas en este estado.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {records.map((record) => (
            <li
              key={record.id}
              className="flex items-center justify-between gap-4 rounded-md border p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{record.email}</p>
                <p className="text-sm text-muted-foreground">
                  {record.emailVerified ? 'Correo verificado' : 'Correo sin verificar'}
                </p>
              </div>
              <Link
                className={buttonVariants({ variant: 'outline' })}
                to={`/administrators/${encodeURIComponent(record.id)}`}
                state={{ fromList: location.search }}
              >
                Ver detalle
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AdministratorsListContent() {
  const { data, total, error, isPending, isFetching, refetch } =
    useListContext<AdminAdministrator>();
  if (isPending || isFetching) return <p role="status">Cargando administradores…</p>;
  if (error !== null) {
    return (
      <div role="alert" className="space-y-3">
        <p>
          {error instanceof ApiError && error.status === 403
            ? 'Acceso denegado'
            : 'No pudimos cargar los administradores. Tu sesión se conserva.'}
        </p>
        <Button onClick={() => void refetch()}>Reintentar</Button>
      </div>
    );
  }
  if (data.length === 0) return <p role="status">No hay administradores para esta búsqueda.</p>;
  return (
    <div className="space-y-8">
      <p role="status">
        {total} {total === 1 ? 'administrador' : 'administradores'} en total
      </p>
      <AdministratorGroup
        title="Activos"
        records={data.filter((record) => record.access.state === 'active')}
      />
      <AdministratorGroup
        title="Deshabilitados"
        records={data.filter((record) => record.access.state === 'disabled')}
      />
    </div>
  );
}

export function AdministratorsList() {
  return (
    <div className="space-y-8">
      <AdministratorInvitations />
      <List
        title="Administradores"
        perPage={perPage}
        sort={{ field: 'email', order: 'ASC' }}
        filters={filters}
        actions={false}
        pagination={<ListPagination rowsPerPageOptions={[perPage]} />}
        queryOptions={{ retry: false, staleTime: 0 }}
      >
        <AdministratorsListContent />
      </List>
    </div>
  );
}
