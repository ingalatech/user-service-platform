import { useState } from 'react';
import { useNotify } from 'ra-core';
import { Link, useParams, useSearchParams } from 'react-router';
import { DataTable } from '../kit/components/admin/data-table.js';
import { Show } from '../kit/components/admin/show.js';
import { Button } from '../kit/components/ui/button.js';
import { Separator } from '../kit/components/ui/separator.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../kit/components/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../kit/components/ui/tabs.js';
import { PrototypeConfirmAction } from './confirm-dialog.js';
import { PrototypeList } from './prototype-list.js';
import type { PrototypeAdministrator } from './prototype-data.js';
import {
  prototypeActivity,
  prototypeAdministrators,
  prototypeAuditEvents,
  prototypeInvitations,
  findPrototypeAdministrator,
} from './prototype-data.js';

function AdministratorTabs({ children }: { children: React.ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = searchParams.get('section') === 'invitations' ? 'invitations' : 'accounts';
  const setSection = (value: string) => {
    setSearchParams({ section: value });
  };
  return (
    <Tabs value={active} onValueChange={setSection}>
      <TabsList aria-label="Secciones de administradores">
        <TabsTrigger value="accounts">Cuentas</TabsTrigger>
        <TabsTrigger value="invitations">Invitaciones</TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  );
}

export function AdministratorsList() {
  const notify = useNotify();
  return (
    <AdministratorTabs>
      <TabsContent value="accounts" className="mt-5">
        <PrototypeList
          resource="administrators"
          title="Administradores"
          records={prototypeAdministrators}
        >
          <DataTable
            tableLabel="Cuentas de administradores"
            bulkActionButtons={false}
            rowClick={false}
          >
            <DataTable.Col source="email" label="Correo electrónico" />
            <DataTable.Col source="role" label="Rol" />
            <DataTable.Col
              source="emailVerified"
              label="Verificación"
              render={(record) => (record.emailVerified ? 'Correo verificado' : 'Pendiente')}
            />
            <DataTable.Col
              label="Acciones"
              render={(record) => (
                <Link to={`/administrators/${encodeURIComponent(record.id)}/show`}>
                  Ver detalle
                </Link>
              )}
            />
          </DataTable>
        </PrototypeList>
      </TabsContent>
      <TabsContent value="invitations" className="mt-5">
        <PrototypeList
          resource="administrators"
          title="Invitaciones"
          records={prototypeInvitations}
        >
          <DataTable
            tableLabel="Invitaciones de administradores"
            bulkActionButtons={false}
            rowClick={false}
          >
            <DataTable.Col source="email" label="Correo electrónico" />
            <DataTable.Col source="role" label="Rol" />
            <DataTable.Col source="status" label="Estado" />
            <DataTable.Col label="Acciones">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  notify('Reenvío simulado en este prototipo.', { type: 'success' });
                }}
              >
                Reenviar
              </Button>
            </DataTable.Col>
          </DataTable>
        </PrototypeList>
      </TabsContent>
    </AdministratorTabs>
  );
}

function AdministratorSummary({ record }: { record: PrototypeAdministrator }) {
  const [disabled, setDisabled] = useState(false);
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="administrator-summary-title">
        <h3 id="administrator-summary-title" className="text-base font-semibold">
          Cuenta
        </h3>
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <span className="text-muted-foreground">Correo electrónico:</span> {record.email}
          </p>
          <p>
            <span className="text-muted-foreground">Rol:</span> {record.role}
          </p>
          <p>
            <span className="text-muted-foreground">Estado:</span>{' '}
            {disabled ? 'Deshabilitada' : 'Activa'}
          </p>
        </div>
      </section>
      <Separator />
      <PrototypeConfirmAction
        label={disabled ? 'Rehabilitar' : 'Deshabilitar'}
        title={disabled ? 'Rehabilitar administrador' : 'Deshabilitar administrador'}
        description="Este cambio es simulado y no afecta permisos reales."
        onConfirm={() => {
          setDisabled((value) => !value);
        }}
      />
    </div>
  );
}

function AdministratorAccess() {
  const notify = useNotify();
  return (
    <div className="space-y-3">
      <p className="text-sm">Correo verificado y autenticación administrada por el servicio.</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          notify('Reenvío simulado en este prototipo.', { type: 'success' });
        }}
      >
        Reenviar verificación
      </Button>
    </div>
  );
}

function AdministratorActivity() {
  return (
    <Table aria-label="Actividad del administrador">
      <TableHeader>
        <TableRow>
          <TableHead>Fecha</TableHead>
          <TableHead>Evento</TableHead>
          <TableHead>Detalle</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {prototypeActivity.slice(0, 2).map((event) => (
          <TableRow key={event.date}>
            <TableCell>{event.date}</TableCell>
            <TableCell>{event.event}</TableCell>
            <TableCell>{event.detail}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AdministratorsShow() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const record = findPrototypeAdministrator(id);
  if (!record) {
    return (
      <section className="space-y-4 py-4" aria-labelledby="administrator-detail-title">
        <h1 id="administrator-detail-title" className="text-2xl font-bold tracking-tight">
          Detalle de administrador
        </h1>
        <div role="alert">
          <h2>Administrador no encontrado</h2>
          <p>No existe ningún administrador con este identificador.</p>
        </div>
        <Link to="/administrators">Volver a la lista</Link>
      </section>
    );
  }
  const active =
    searchParams.get('tab') === 'acceso' || searchParams.get('tab') === 'actividad'
      ? searchParams.get('tab')
      : 'resumen';
  return (
    <Show
      title="Detalle de administrador"
      actions={false}
      queryOptions={{ enabled: false, initialData: record }}
    >
      <Tabs
        value={active}
        onValueChange={(value: string) => {
          setSearchParams({ tab: value });
        }}
      >
        <TabsList aria-label="Secciones de administrador">
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="acceso">Acceso</TabsTrigger>
          <TabsTrigger value="actividad">Actividad</TabsTrigger>
        </TabsList>
        <TabsContent value="resumen" className="mt-5">
          <AdministratorSummary record={record} />
        </TabsContent>
        <TabsContent value="acceso" className="mt-5">
          <AdministratorAccess />
        </TabsContent>
        <TabsContent value="actividad" className="mt-5">
          <AdministratorActivity />
        </TabsContent>
      </Tabs>
    </Show>
  );
}

export function AdministrativeAuditList() {
  return (
    <PrototypeList resource="audit" title="Auditoría administrativa" records={prototypeAuditEvents}>
      <DataTable tableLabel="Auditoría administrativa" bulkActionButtons={false} rowClick={false}>
        <DataTable.Col source="date" label="Fecha" />
        <DataTable.Col source="action" label="Acción" />
        <DataTable.Col source="actor" label="Operador" />
        <DataTable.Col source="target" label="Objetivo" />
      </DataTable>
    </PrototypeList>
  );
}
