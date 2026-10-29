import { useListContext } from 'ra-core';
import type { ComponentProps, ReactElement } from 'react';
import type { AdminUser } from './generated/contracts.js';
import { ApiError } from './api.js';
import { DataTable } from './kit/components/admin/data-table.js';
import { List } from './kit/components/admin/list.js';
import { ListPagination } from './kit/components/admin/list-pagination.js';
import { SearchInput } from './kit/components/admin/search-input.js';
import { ShowButton } from './kit/components/admin/show-button.js';
import { Button } from './kit/components/ui/button.js';

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
  <EmailSearchInput
    key="email"
    source="email"
    alwaysOn
    maxLength={254}
    aria-label="Buscar por correo electrónico"
  />,
];

function UsersListContent() {
  const { data, total, error, isPending, isFetching, refetch } = useListContext<AdminUser>();

  if (isPending || isFetching) {
    return <p role="status">Cargando usuarios…</p>;
  }

  if (error !== null) {
    return (
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
    );
  }

  if (data.length === 0) {
    return (
      <div role="status" className="py-16 text-center">
        <h2 className="text-xl font-semibold">Sin resultados</h2>
        <p className="text-muted-foreground">No hay usuarios que coincidan con esta búsqueda.</p>
      </div>
    );
  }

  return (
    <>
      <p role="status">
        {total} {total === 1 ? 'usuario' : 'usuarios'} en total
      </p>
      <DataTable bulkActionButtons={false} rowClick={false} tableLabel="Listado de usuarios">
        <DataTable.Col source="email" label="Correo electrónico" />
        <DataTable.Col
          source="emailVerified"
          label="Verificación"
          render={(record) => (record.emailVerified ? 'Correo verificado' : 'Correo sin verificar')}
        />
        <DataTable.Col source="role" label="Rol" />
        <DataTable.Col label="Acciones">
          <ShowButton label="Ver detalle" />
        </DataTable.Col>
      </DataTable>
    </>
  );
}

export function UsersList() {
  return (
    <List
      title="Usuarios"
      perPage={perPage}
      sort={{ field: 'email', order: 'ASC' }}
      filters={filters}
      actions={false}
      pagination={<ListPagination rowsPerPageOptions={[perPage]} />}
      queryOptions={{ retry: false, staleTime: 0 }}
    >
      <UsersListContent />
    </List>
  );
}
