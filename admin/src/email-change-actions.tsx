import { useEffect, useState } from 'react';
import type { AdminReaderDetail } from './generated/contracts.js';
import {
  adminCancelReaderEmailChange,
  adminResendReaderEmailChangeMessage,
  adminStartReaderEmailChange,
  ApiError,
} from './api.js';
import { Button } from './kit/components/ui/button.js';

type EmailChangeWorkflow = Extract<
  AdminReaderDetail['activeWorkflows'][number],
  { type: 'email-change' }
>;

interface StartAttempt {
  readonly email: string;
  readonly accountRevision: number;
  readonly key: string;
}

function cooldownSeconds(until: string | undefined, now: number): number | null {
  if (until === undefined) return null;
  const remaining = Date.parse(until) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return Math.ceil(remaining / 1000);
}

function emailChangeErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'No pudimos completar el cambio de correo.';
  if (error.status === 400 && error.code === 'bad-request') {
    return 'Revisa el formato del correo electrónico.';
  }
  if (error.status === 404 && error.code === 'reader-not-found') {
    return 'No se encontró el usuario.';
  }
  if (error.status === 404 && error.code === 'email-change-not-found') {
    return 'La solicitud de cambio ya no está disponible.';
  }
  if (error.status === 409 && error.code === 'same-email') {
    return 'Ese correo ya es el correo canónico del usuario.';
  }
  if (error.status === 409 && error.code === 'email-conflict') {
    return 'Ese correo ya está en uso o reservado.';
  }
  if (error.status === 409 && error.code === 'invalid-transition') {
    return 'La solicitud ya no está pendiente y no se puede modificar.';
  }
  if (error.status === 409 && error.code === 'idempotency-key-reused') {
    return 'La solicitud no coincide con el intento anterior. Vuelve a intentarlo.';
  }
  if (error.status === 412 && error.code === 'stale-revision') {
    return 'La cuenta o solicitud cambió. Actualiza el detalle antes de reintentar.';
  }
  if (error.status === 428 && error.code === 'precondition-required') {
    return 'La cuenta cambió. Actualiza el detalle antes de reintentar.';
  }
  if (error.status === 429 && error.code === 'cooldown-active') {
    return `Espera ${String(error.retryAfterSeconds ?? 60)} segundos antes de volver a enviar.`;
  }
  if (error.status === 503 && error.code === 'delivery-scheduling-failed') {
    return 'No pudimos programar los avisos. Reintenta con la misma solicitud.';
  }
  if (error.status === 0 || error.status >= 500) {
    return 'No recibimos una respuesta. Reintenta con la misma solicitud para comprobar el resultado.';
  }
  if (error.status === 403 && error.code === 'administrator-disabled') {
    return 'Tu cuenta de administración está deshabilitada.';
  }
  return 'No pudimos completar el cambio de correo.';
}

function isRetryableEmailChangeError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ((error.status === 503 && error.code === 'delivery-scheduling-failed') ||
      error.status === 0 ||
      error.status >= 500)
  );
}

export function EmailChangeActions({
  record,
  refresh,
  onTerminalState,
}: {
  record: AdminReaderDetail;
  refresh: () => Promise<unknown>;
  onTerminalState: (state: string | null) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState<StartAttempt | null>(null);
  const [operationKeys, setOperationKeys] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const pending = record.activeWorkflows.find(
    (workflow): workflow is EmailChangeWorkflow => workflow.type === 'email-change',
  );
  const canChange = record.access.state === 'active' && record.access.effectiveState === 'active';
  const workflowRevision = pending?.revision;
  const retryKey = pending === undefined ? undefined : operationKeys[`resend:${pending.id}`];
  const cooldown = cooldownSeconds(pending?.cooldownUntil, now);
  const expired = pending?.expiresAt !== undefined && Date.parse(pending.expiresAt) <= now;

  const clearOperationKey = (key: string) => {
    setOperationKeys((current) =>
      Object.fromEntries(Object.entries(current).filter(([currentKey]) => currentKey !== key)),
    );
  };

  const startOrReplace = async () => {
    const requestedEmail = email.trim();
    if (requestedEmail.length === 0) {
      setStatus('Escribe el nuevo correo electrónico.');
      return;
    }
    const replacing = pending !== undefined;
    const attempt =
      startAttempt?.email === requestedEmail
        ? startAttempt
        : {
            email: requestedEmail,
            accountRevision: record.revision,
            key: crypto.randomUUID(),
          };
    setStartAttempt(attempt);
    setBusy(true);
    setStatus(null);
    try {
      await adminStartReaderEmailChange(
        record.id,
        attempt.email,
        attempt.accountRevision,
        attempt.key,
      );
      setStartAttempt(null);
      setEmail('');
      onTerminalState(replacing ? 'superseded' : null);
      setStatus(
        replacing
          ? 'La solicitud anterior fue reemplazada por una nueva.'
          : 'Solicitud de cambio creada; el correo canónico no cambia hasta verificar el nuevo correo.',
      );
      await refresh().catch(() => undefined);
    } catch (error) {
      setStatus(emailChangeErrorMessage(error));
      if (isRetryableEmailChangeError(error)) {
        // Scheduling failures are committed server-side. Keep this attempt and
        // its idempotency key visible so the operator can retry it unchanged;
        // refresh only after that retry returns a successful committed result.
      } else {
        setStartAttempt(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async (workflow: EmailChangeWorkflow) => {
    const operationKey = `resend:${workflow.id}`;
    const key = operationKeys[operationKey] ?? crypto.randomUUID();
    setOperationKeys((current) => ({ ...current, [operationKey]: key }));
    setBusy(true);
    setStatus(null);
    try {
      await adminResendReaderEmailChangeMessage(record.id, workflow.id, key);
      clearOperationKey(operationKey);
      setStatus('Avisos de verificación programados para la solicitud pendiente.');
      await refresh().catch(() => undefined);
    } catch (error) {
      setStatus(emailChangeErrorMessage(error));
      if (error instanceof ApiError && error.status === 429 && error.code === 'cooldown-active') {
        clearOperationKey(operationKey);
      } else if (isRetryableEmailChangeError(error)) {
        // Keep the same key and the currently loaded pending workflow. The
        // retry success below is the next point at which detail is refreshed.
      } else {
        clearOperationKey(operationKey);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (workflow: EmailChangeWorkflow) => {
    const revision = workflow.revision;
    const operationKey = `cancel:${workflow.id}`;
    const key = operationKeys[operationKey] ?? crypto.randomUUID();
    setOperationKeys((current) => ({ ...current, [operationKey]: key }));
    setBusy(true);
    setStatus(null);
    try {
      const result = await adminCancelReaderEmailChange(record.id, workflow.id, revision, key);
      clearOperationKey(operationKey);
      onTerminalState(result.state);
      setStatus(
        result.changed ? 'Solicitud de cambio cancelada.' : 'La solicitud ya estaba cancelada.',
      );
      await refresh().catch(() => undefined);
    } catch (error) {
      setStatus(emailChangeErrorMessage(error));
      if (isRetryableEmailChangeError(error)) {
        if (
          error instanceof ApiError &&
          error.status === 503 &&
          error.code === 'delivery-scheduling-failed'
        ) {
          await refresh().catch(() => undefined);
        }
      } else {
        clearOperationKey(operationKey);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-md border p-4" aria-labelledby="email-change-title">
      <h3 id="email-change-title" className="font-semibold">
        Cambio de correo electrónico
      </h3>
      <p>
        Correo canónico actual: <strong className="break-all">{record.email}</strong>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void refresh().catch(() => {
            setStatus('No pudimos actualizar el estado de la solicitud.');
          });
        }}
      >
        Actualizar estado
      </Button>
      {pending !== undefined ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Correo pendiente</dt>
            <dd className="break-all">{pending.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Estado</dt>
            <dd>{expired ? 'Caducada' : 'Pendiente de verificación'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Expira</dt>
            <dd>
              {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(pending.expiresAt),
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cooldown</dt>
            <dd>
              {cooldown === null
                ? 'Disponible para reenviar'
                : `${String(cooldown)} s para poder reenviar`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Revisión del workflow</dt>
            <dd>{workflowRevision === undefined ? 'No disponible' : String(workflowRevision)}</dd>
          </div>
        </dl>
      ) : (
        <p>No hay una solicitud de cambio de correo pendiente.</p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span>{pending === undefined ? 'Nuevo correo' : 'Reemplazar con otro correo'}</span>
          <input
            type="email"
            maxLength={254}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            value={email}
            disabled={!canChange || busy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>
        <Button
          type="button"
          disabled={!canChange || busy || email.trim().length === 0}
          onClick={() => {
            void startOrReplace();
          }}
        >
          {busy
            ? 'Procesando…'
            : startAttempt !== null
              ? 'Reintentar solicitud'
              : pending === undefined
                ? 'Iniciar cambio'
                : 'Reemplazar solicitud'}
        </Button>
      </div>
      {!canChange ? (
        <p className="text-sm text-muted-foreground">
          El cambio requiere que el acceso efectivo del usuario esté activo.
        </p>
      ) : null}
      {pending !== undefined ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              !canChange || busy || expired || (cooldown !== null && retryKey === undefined)
            }
            onClick={() => {
              void resend(pending);
            }}
          >
            {retryKey !== undefined ? 'Reintentar avisos' : 'Reenviar avisos'}
          </Button>
          <Button
            variant="outline"
            disabled={busy || workflowRevision === undefined}
            onClick={() => {
              void cancel(pending);
            }}
          >
            Cancelar solicitud
          </Button>
        </div>
      ) : null}
      {status !== null ? <p role="status">{status}</p> : null}
    </section>
  );
}
