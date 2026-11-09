import { useState } from 'react';
import type { AdminReaderDetail } from './generated/contracts.js';
import { adminUnlinkReaderSocialIdentity, ApiError } from './api.js';
import { Button } from './kit/components/ui/button.js';

type SocialIdentity = AdminReaderDetail['socialIdentities'][number];

type SocialUnlinkCommand = Readonly<{
  readerId: string;
  associationId: string;
  accountRevision: number;
  idempotencyKey: string;
}>;

function freezeCommand(command: SocialUnlinkCommand): SocialUnlinkCommand {
  return Object.freeze(command);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'No recibimos una respuesta definitiva. Reintenta la misma desvinculación para comprobar el resultado.';
  }
  if (error.status === 409 && error.code === 'no-usable-login-method') {
    return 'No se puede quitar el último método de acceso utilizable del Reader.';
  }
  if (error.status === 409 && error.code === 'active-deletion-request') {
    return 'No se pueden administrar asociaciones mientras una solicitud de eliminación esté activa.';
  }
  if (error.status === 412 && error.code === 'stale-revision') {
    return 'La cuenta cambió. Actualiza los datos antes de volver a intentarlo.';
  }
  if (error.status === 428 && error.code === 'precondition-required') {
    return 'Falta la revisión de la cuenta. Actualiza los datos antes de volver a intentarlo.';
  }
  if (error.status === 503 && error.code === 'delivery-scheduling-failed') {
    return 'La asociación se quitó, pero no se pudo programar el aviso de seguridad. Reintenta el mismo comando.';
  }
  if (error.status === 409 && error.code === 'idempotency-key-reused') {
    return 'El intento no coincide con el comando pendiente. Actualiza los datos antes de continuar.';
  }
  if (error.status === 404 && error.code === 'reader-not-found') {
    return 'No se encontró el Reader.';
  }
  if (error.status === 0 || error.status >= 500) {
    return 'No recibimos una respuesta definitiva. Reintenta la misma desvinculación para comprobar el resultado.';
  }
  return 'No se pudo desvincular la asociación social.';
}

function SocialIdentityItem({
  record,
  identity,
  refresh,
  onNoop,
}: {
  record: AdminReaderDetail;
  identity: SocialIdentity;
  refresh: () => Promise<unknown>;
  onNoop: () => void;
}) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<SocialUnlinkCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const unlink = async (command: SocialUnlinkCommand) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await adminUnlinkReaderSocialIdentity(
        command.readerId,
        command.associationId,
        command.accountRevision,
        command.idempotencyKey,
      );
      setPendingCommand(null);
      setConfirmationOpen(false);
      if (!result.changed) {
        await refresh();
        onNoop();
        return;
      }
      try {
        await refresh();
        setStatus(
          `Asociación ${identity.providerDisplayName} desvinculada; sesiones Reader revocadas.`,
        );
      } catch {
        setStatus(
          'La desvinculación se confirmó. No pudimos actualizar la vista; vuelve a cargarla.',
        );
      }
    } catch (error) {
      const retryable =
        (error instanceof ApiError &&
          ((error.status === 503 && error.code === 'delivery-scheduling-failed') ||
            error.status === 0 ||
            error.status >= 500)) ||
        !(error instanceof ApiError);
      setStatus(errorMessage(error));
      if (retryable) {
        setPendingCommand(command);
        setConfirmationOpen(false);
      } else {
        setPendingCommand(null);
        setConfirmationOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmUnlink = () => {
    const command = freezeCommand({
      readerId: record.id,
      associationId: identity.associationId,
      accountRevision: record.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    setPendingCommand(command);
    setConfirmationOpen(false);
    void unlink(command);
  };

  return (
    <li className="space-y-3 rounded-md border p-4">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Proveedor</dt>
          <dd>{identity.providerDisplayName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Asociación opaca</dt>
          <dd className="break-all font-mono text-xs">{identity.associationId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Vinculada</dt>
          <dd>
            {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(identity.linkedAt),
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Disponibilidad local</dt>
          <dd>
            {identity.state === 'available' ? 'Utilizable' : 'No disponible en esta configuración'}
          </dd>
        </div>
      </dl>
      {pendingCommand === null ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setConfirmationOpen(true);
          }}
        >
          Desvincular {identity.providerDisplayName}
        </Button>
      ) : (
        <div className="space-y-2">
          <p role="status">
            Hay un intento de desvinculación pendiente para {identity.providerDisplayName}.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void unlink(pendingCommand);
            }}
          >
            {busy ? 'Comprobando…' : 'Reintentar desvinculación pendiente'}
          </Button>
        </div>
      )}
      {status !== null ? <p role="status">{status}</p> : null}
      {confirmationOpen ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`social-unlink-title-${identity.associationId}`}
          aria-describedby={`social-unlink-description-${identity.associationId}`}
          className="space-y-3 rounded-md border p-4"
        >
          <h4 id={`social-unlink-title-${identity.associationId}`} className="font-semibold">
            Confirmar desvinculación de {identity.providerDisplayName}
          </h4>
          <p id={`social-unlink-description-${identity.associationId}`}>
            Se quitarán esta asociación local y sus credenciales, se revocarán todas las sesiones
            Reader.{' '}
            {record.emailVerified
              ? 'Se programará un aviso de seguridad porque el correo canónico está verificado. '
              : 'No se puede programar un aviso automático porque el correo canónico no está verificado. '}
            No se revocarán permisos en {identity.providerDisplayName}. Si es el último método
            utilizable, el servicio rechazará la acción.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button autoFocus disabled={busy} onClick={confirmUnlink}>
              Confirmar desvinculación de {identity.providerDisplayName}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setConfirmationOpen(false);
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function SocialIdentityActions({
  record,
  refresh,
  onNoop,
}: {
  record: AdminReaderDetail;
  refresh: () => Promise<unknown>;
  onNoop: () => void;
}) {
  return (
    <section className="space-y-3 rounded-md border p-4" aria-labelledby="social-identities-title">
      <h3 id="social-identities-title" className="font-semibold">
        Identidades sociales
      </h3>
      {record.socialIdentities.length === 0 ? (
        <p>No hay asociaciones sociales vinculadas.</p>
      ) : (
        <ul className="space-y-3">
          {record.socialIdentities.map((identity) => (
            <SocialIdentityItem
              key={identity.associationId}
              record={record}
              identity={identity}
              refresh={refresh}
              onNoop={onNoop}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
