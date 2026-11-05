import { useState } from 'react';
import type { AdminReaderDetail } from './generated/contracts.js';
import {
  adminCreateReaderDeletionRequest,
  adminTransitionReaderDeletionRequest,
  ApiError,
} from './api.js';
import { Button } from './kit/components/ui/button.js';
import { Textarea } from './kit/components/ui/textarea.js';

type DeletionWorkflow = Extract<
  AdminReaderDetail['activeWorkflows'][number],
  { type: 'deletion-request' }
>;

type DeletionTransition = 'approved' | 'rejected' | 'cancelled';

type PendingDeletionCommand =
  | Readonly<{
      operation: 'create';
      requestId: string;
      readerId: string;
      idempotencyKey: string;
      accountRevision: number;
      body: Readonly<{ note?: string }>;
    }>
  | Readonly<{
      operation: 'transition';
      requestId: string;
      readerId: string;
      idempotencyKey: string;
      workflowRevision: number;
      transition: DeletionTransition;
      body: Readonly<{ state: DeletionTransition; note?: string }>;
    }>;

type Confirmation =
  | Readonly<{ operation: 'create' }>
  | Readonly<{ operation: 'transition'; transition: DeletionTransition; label: string }>;

function freezeCommand(command: PendingDeletionCommand): PendingDeletionCommand {
  Object.freeze(command.body);
  return Object.freeze(command);
}

export function DeletionRequestActions({
  record,
  refresh,
}: {
  record: AdminReaderDetail;
  refresh: () => Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingDeletionCommand | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const workflow = record.activeWorkflows.find(
    (item): item is DeletionWorkflow => item.type === 'deletion-request',
  );

  const execute = (command: PendingDeletionCommand) => {
    if (command.operation === 'create') {
      return adminCreateReaderDeletionRequest(
        command.readerId,
        command.accountRevision,
        command.idempotencyKey,
        command.body.note,
      );
    }
    return adminTransitionReaderDeletionRequest(
      command.readerId,
      command.requestId,
      command.workflowRevision,
      command.transition,
      command.idempotencyKey,
      command.body.note,
    );
  };

  const run = async (command: PendingDeletionCommand) => {
    setBusy(true);
    setStatus(null);
    try {
      await execute(command);
      setPendingCommand(null);
      setConfirmation(null);
      setNote('');
      try {
        await refresh();
        setStatus('La solicitud se actualizó.');
      } catch {
        setStatus(
          'La acción se confirmó. No pudimos actualizar la vista; vuelve a cargar los datos.',
        );
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) {
        setPendingCommand(command);
        setStatus(
          'No recibimos una respuesta definitiva. Reintenta esta misma acción para comprobar el resultado.',
        );
      } else {
        setPendingCommand(null);
        setConfirmation(null);
        if (error.status === 412 && error.code === 'stale-revision') {
          setStatus('El usuario o la solicitud cambió. Actualiza los datos antes de reintentar.');
        } else if (error.status === 409 && error.code === 'invalid-transition') {
          setStatus('La solicitud ya no permite esta transición.');
        } else if (error.status === 409 && error.code === 'active-deletion-request') {
          setStatus('Ya existe una solicitud activa para este usuario.');
        } else {
          setStatus('No pudimos completar la acción. Inténtalo de nuevo.');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (pendingCommand !== null) {
      void run(pendingCommand);
      return;
    }
    if (confirmation?.operation === 'create') {
      const body = Object.freeze(note.trim().length > 0 ? { note: note.trim() } : {});
      void run(
        freezeCommand({
          operation: 'create',
          requestId: crypto.randomUUID(),
          readerId: record.id,
          idempotencyKey: crypto.randomUUID(),
          accountRevision: record.revision,
          body,
        }),
      );
      return;
    }
    if (confirmation?.operation === 'transition' && workflow !== undefined) {
      const body = Object.freeze(
        note.trim().length > 0
          ? { state: confirmation.transition, note: note.trim() }
          : { state: confirmation.transition },
      );
      void run(
        freezeCommand({
          operation: 'transition',
          requestId: workflow.id,
          readerId: record.id,
          idempotencyKey: crypto.randomUUID(),
          workflowRevision: workflow.revision,
          transition: confirmation.transition,
          body,
        }),
      );
    }
  };

  const requestTransition = (transition: DeletionTransition, label: string) => {
    setConfirmation({ operation: 'transition', transition, label });
  };

  return (
    <section className="space-y-3 rounded-md border p-4" aria-labelledby="deletion-request-title">
      <h3 id="deletion-request-title" className="font-semibold">
        Solicitud de eliminación
      </h3>
      {workflow === undefined ? (
        <>
          <p>No hay una solicitud activa. Crear una suspende el acceso y revoca las sesiones.</p>
          <label className="block space-y-1" htmlFor="deletion-request-note">
            <span>
              {pendingCommand?.operation === 'create'
                ? 'Nota borrador (la repetición usa la nota capturada)'
                : 'Nota (opcional)'}
            </span>
            <Textarea
              id="deletion-request-note"
              value={note}
              maxLength={2000}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>
          <Button
            disabled={busy || pendingCommand !== null}
            onClick={() => {
              setConfirmation({ operation: 'create' });
            }}
          >
            Crear solicitud
          </Button>
        </>
      ) : (
        <>
          <p>
            Estado: {workflow.state === 'pending_review' ? 'Pendiente de revisión' : 'Aprobada'}
          </p>
          <p>
            Acceso previo (snapshot):{' '}
            {workflow.previousAccessState === 'active' ? 'Activo' : 'Deshabilitado'}
          </p>
          <p>Revisión del workflow: {workflow.revision}</p>
          <p>
            Creada:{' '}
            {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(workflow.createdAt),
            )}
          </p>
          <label className="block space-y-1" htmlFor="deletion-decision-note">
            <span>
              {pendingCommand?.operation === 'transition'
                ? 'Nota borrador (la repetición usa la nota capturada)'
                : 'Nota (obligatoria para aprobar o rechazar)'}
            </span>
            <Textarea
              id="deletion-decision-note"
              value={note}
              maxLength={2000}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </label>
          {pendingCommand?.operation === 'transition' ? (
            <p role="status">
              Reintento congelado: {pendingCommand.transition}; revisión{' '}
              {pendingCommand.workflowRevision}.
            </p>
          ) : null}
          {workflow.state === 'pending_review' ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || pendingCommand !== null || note.trim().length === 0}
                onClick={() => {
                  requestTransition('approved', 'aprobar la solicitud de eliminación');
                }}
              >
                Aprobar solicitud
              </Button>
              <Button
                variant="outline"
                disabled={busy || pendingCommand !== null || note.trim().length === 0}
                onClick={() => {
                  requestTransition('rejected', 'rechazar la solicitud de eliminación');
                }}
              >
                Rechazar solicitud
              </Button>
              <Button
                variant="outline"
                disabled={busy || pendingCommand !== null}
                onClick={() => {
                  requestTransition('cancelled', 'cancelar la solicitud de eliminación');
                }}
              >
                Cancelar solicitud
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              disabled={busy || pendingCommand !== null}
              onClick={() => {
                requestTransition('cancelled', 'cancelar la aprobación');
              }}
            >
              Cancelar aprobación
            </Button>
          )}
        </>
      )}
      {status !== null ? <p role="status">{status}</p> : null}
      {confirmation !== null ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="deletion-confirm-title"
          aria-describedby="deletion-confirm-description"
          className="space-y-3 rounded-md border p-4"
        >
          <h4 id="deletion-confirm-title" className="font-semibold">
            Confirmar acción
          </h4>
          <p id="deletion-confirm-description">
            {pendingCommand !== null
              ? `Repetir la acción ${pendingCommand.operation} con la nota, revisión y clave originales.`
              : confirmation.operation === 'create'
                ? '¿Confirmas crear una solicitud de eliminación y suspender el acceso del Reader?'
                : `¿Confirmas ${confirmation.label}?`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button autoFocus disabled={busy} onClick={confirm}>
              {pendingCommand === null ? 'Confirmar' : 'Reintentar acción pendiente'}
            </Button>
            {pendingCommand === null ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setConfirmation(null);
                }}
              >
                Volver
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
