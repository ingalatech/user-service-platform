/* Prototype question: does one route-backed tab set clarify the User account hierarchy? */
import { useState } from 'react';
import { useNotify, useRecordContext } from 'ra-core';
import { Link, useSearchParams } from 'react-router';
import type { AdminUser } from '../generated/contracts.js';
import { RecordField } from '../kit/components/admin/record-field.js';
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
import {
  prototypeAccountData,
  prototypeActivity,
  prototypeSessions,
  prototypeUser,
} from './prototype-data.js';

const userTabs = ['resumen', 'acceso', 'sesiones', 'ciclo-de-vida', 'actividad'] as const;
type UserTab = (typeof userTabs)[number];

function tabFromSearch(value: string | null): UserTab {
  return userTabs.includes(value as UserTab) ? (value as UserTab) : 'resumen';
}

function SimulatedAction({ children }: { children: string }) {
  const notify = useNotify();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        notify('Acción simulada en este prototipo.', { type: 'success' });
      }}
    >
      {children}
    </Button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={`${title}-title`}>
      <h3 id={`${title}-title`} className="text-base font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function SummaryTab({ record }: { record: AdminUser }) {
  return (
    <div className="space-y-6">
      <Section title="Identidad">
        <div className="flex flex-col gap-3">
          <RecordField record={record} source="email" label="Correo electrónico canónico" />
          <RecordField
            record={record}
            source="emailVerified"
            label="Estado del correo"
            render={(value) => (value.emailVerified ? 'Verificado' : 'Pendiente')}
          />
          <RecordField record={record} source="role" label="Rol" />
        </div>
      </Section>
      <Separator />
      <Section title="Datos de cuenta">
        <div className="flex flex-col gap-3">
          <RecordField record={prototypeAccountData} source="firstName" label="Nombre" />
          <RecordField record={prototypeAccountData} source="lastName" label="Apellidos" />
          <RecordField record={prototypeAccountData} source="phone" label="Teléfono" />
        </div>
        <Link
          to={`/users/${encodeURIComponent(record.id)}`}
          className="inline-flex text-sm underline underline-offset-4"
        >
          Editar datos de cuenta
        </Link>
      </Section>
      <Separator />
      <Section title="Estado de acceso">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Métodos disponibles</dt>
            <dd>Contraseña, correo electrónico</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Acceso efectivo</dt>
            <dd>Permitido</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Solicitud de eliminación</dt>
            <dd>Ninguna</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

function AccessTab({ record }: { record: AdminUser }) {
  return (
    <div className="space-y-6">
      <Section title="Correo y verificación">
        <div className="flex flex-col gap-3">
          <RecordField record={record} source="email" label="Correo electrónico" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Correo verificado</span>
            <SimulatedAction>Reenviar verificación</SimulatedAction>
          </div>
        </div>
      </Section>
      <Separator />
      <Section title="Cambios y recuperación">
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <span className="text-muted-foreground">Cambio de correo pendiente:</span> Ninguno
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span>Recuperación de contraseña</span>
            <SimulatedAction>Enviar enlace de recuperación</SimulatedAction>
          </div>
        </div>
      </Section>
      <Separator />
      <Section title="Proveedores sociales">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Ningún proveedor vinculado</span>
          <PrototypeConfirmAction
            label="Desvincular proveedor"
            title="Desvincular proveedor social"
            description="Esta acción simulada requiere confirmación crítica."
            confirmLabel="Desvincular"
          />
        </div>
      </Section>
    </div>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState(prototypeSessions);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Sesiones activas de este usuario.</p>
        <PrototypeConfirmAction
          label="Revocar todas"
          title="Revocar todas las sesiones"
          description="Se cerrarán las sesiones activas. Esta acción es simulada."
          confirmLabel="Revocar todas"
          onConfirm={() => {
            setSessions([]);
          }}
        />
      </div>
      <Table aria-label="Sesiones activas">
        <TableHeader>
          <TableRow>
            <TableHead>Dispositivo</TableHead>
            <TableHead>Última actividad</TableHead>
            <TableHead>Ubicación</TableHead>
            <TableHead>
              <span className="sr-only">Acciones</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id}>
              <TableCell>{session.device}</TableCell>
              <TableCell>{session.lastSeen}</TableCell>
              <TableCell>{session.location}</TableCell>
              <TableCell>
                <PrototypeConfirmAction
                  label="Revocar"
                  title="Revocar sesión"
                  description="La sesión se revocará sólo en esta vista de prototipo."
                  confirmLabel="Revocar"
                  onConfirm={() => {
                    setSessions((current) => current.filter((item) => item.id !== session.id));
                  }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sessions.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          No hay sesiones activas.
        </p>
      )}
    </div>
  );
}

function LifecycleTab() {
  const [state, setState] = useState<'active' | 'disabled'>('active');
  return (
    <div className="space-y-6">
      <Section title="Estado de la cuenta">
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Estado actual</dt>
            <dd>{state === 'active' ? 'Activa' : 'Deshabilitada'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Solicitud de eliminación</dt>
            <dd>Ninguna</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Resultado de revisión</dt>
            <dd>No revisada</dd>
          </div>
        </dl>
      </Section>
      <div className="flex flex-wrap gap-2">
        <PrototypeConfirmAction
          label={state === 'active' ? 'Deshabilitar cuenta' : 'Rehabilitar cuenta'}
          title={state === 'active' ? 'Deshabilitar cuenta' : 'Rehabilitar cuenta'}
          description="El cambio es simulado y no modifica datos reales."
          confirmLabel="Confirmar"
          onConfirm={() => {
            setState((current) => (current === 'active' ? 'disabled' : 'active'));
          }}
        />
        <PrototypeConfirmAction
          label="Registrar solicitud de eliminación"
          title="Registrar solicitud de eliminación"
          description="La solicitud es sólo una representación local y no elimina datos."
          confirmLabel="Registrar solicitud"
        />
      </div>
    </div>
  );
}

function ActivityTab() {
  return (
    <Table aria-label="Actividad del usuario">
      <TableHeader>
        <TableRow>
          <TableHead>Fecha</TableHead>
          <TableHead>Evento</TableHead>
          <TableHead>Detalle</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {prototypeActivity.map((event) => (
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

export function UserShowPrototype() {
  const record = prototypeUser(useRecordContext<AdminUser>());
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = tabFromSearch(searchParams.get('tab'));
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value: string) => {
        setSearchParams({ tab: value });
      }}
      className="w-full"
    >
      <TabsList
        aria-label="Secciones de usuario"
        className="w-full justify-start overflow-x-auto sm:w-fit"
      >
        <TabsTrigger value="resumen">Resumen</TabsTrigger>
        <TabsTrigger value="acceso">Acceso</TabsTrigger>
        <TabsTrigger value="sesiones">Sesiones</TabsTrigger>
        <TabsTrigger value="ciclo-de-vida">Ciclo de vida</TabsTrigger>
        <TabsTrigger value="actividad">Actividad</TabsTrigger>
      </TabsList>
      <TabsContent value="resumen" className="mt-5">
        <SummaryTab record={record} />
      </TabsContent>
      <TabsContent value="acceso" className="mt-5">
        <AccessTab record={record} />
      </TabsContent>
      <TabsContent value="sesiones" className="mt-5">
        <SessionsTab />
      </TabsContent>
      <TabsContent value="ciclo-de-vida" className="mt-5">
        <LifecycleTab />
      </TabsContent>
      <TabsContent value="actividad" className="mt-5">
        <ActivityTab />
      </TabsContent>
    </Tabs>
  );
}
