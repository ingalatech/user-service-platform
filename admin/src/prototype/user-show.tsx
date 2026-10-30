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
  prototypeSocialProviders,
  prototypeUserActionLabels,
  prototypeUserTabs,
  prototypeUser,
} from './prototype-data.js';

type UserTab = (typeof prototypeUserTabs)[number]['value'];

function tabFromSearch(value: string | null): UserTab {
  return prototypeUserTabs.some((tab) => tab.value === value) ? (value as UserTab) : 'resumen';
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
          <RecordField record={record} source="id" label="Identificador" />
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
      <Section title="Métodos disponibles">
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Métodos disponibles</dt>
            <dd>Contraseña, correo electrónico</dd>
          </div>
        </dl>
      </Section>
      <Separator />
      <Section title="Estado de acceso">
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Estado</dt>
            <dd>Permitido</dd>
          </div>
        </dl>
      </Section>
      <Separator />
      <Section title="Solicitud de eliminación">
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Solicitud de eliminación</dt>
            <dd>Ninguna</dd>
          </div>
        </dl>
      </Section>
      <Separator />
      <Section title="Acceso efectivo">
        <p className="text-sm">Permitido</p>
      </Section>
    </div>
  );
}

function AccessTab({ record }: { record: AdminUser }) {
  const actions = prototypeUserActionLabels(record.email);
  return (
    <div className="space-y-6">
      <Section title="Correo y verificación">
        <div className="flex flex-col gap-3">
          <RecordField record={record} source="email" label="Correo electrónico" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Correo verificado</span>
            <SimulatedAction>{actions.resendVerification}</SimulatedAction>
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
            <SimulatedAction>{actions.sendRecovery}</SimulatedAction>
          </div>
        </div>
      </Section>
      <Separator />
      <Section title="Proveedores sociales">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {prototypeSocialProviders.length === 0 ? (
            <span>No hay proveedores sociales vinculados.</span>
          ) : (
            <span>{prototypeSocialProviders.join(', ')}</span>
          )}
        </div>
      </Section>
    </div>
  );
}

function SessionsTab({ email }: { email: string }) {
  const [sessions, setSessions] = useState(prototypeSessions);
  const actions = prototypeUserActionLabels(email);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Sesiones activas de este usuario.</p>
        <PrototypeConfirmAction
          label={actions.revokeAllSessions}
          title={actions.revokeAllSessions}
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
                  label={actions.revokeSession}
                  title={actions.revokeSession}
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

function LifecycleTab({ email }: { email: string }) {
  const [state, setState] = useState<'active' | 'disabled'>('active');
  const actions = prototypeUserActionLabels(email);
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
          label={state === 'active' ? actions.disableAccount : actions.enableAccount}
          title={state === 'active' ? actions.disableAccount : actions.enableAccount}
          description="El cambio es simulado y no modifica datos reales."
          confirmLabel="Confirmar"
          onConfirm={() => {
            setState((current) => (current === 'active' ? 'disabled' : 'active'));
          }}
        />
        <PrototypeConfirmAction
          label={actions.requestDeletion}
          title={actions.requestDeletion}
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
        {prototypeUserTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="resumen" className="mt-5">
        <SummaryTab record={record} />
      </TabsContent>
      <TabsContent value="acceso" className="mt-5">
        <AccessTab record={record} />
      </TabsContent>
      <TabsContent value="sesiones" className="mt-5">
        <SessionsTab email={record.email} />
      </TabsContent>
      <TabsContent value="ciclo-de-vida" className="mt-5">
        <LifecycleTab email={record.email} />
      </TabsContent>
      <TabsContent value="actividad" className="mt-5">
        <ActivityTab />
      </TabsContent>
    </Tabs>
  );
}
