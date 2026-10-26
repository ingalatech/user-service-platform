import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { useGetOne } from 'ra-core';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import type { AccountDetails, AdminUser, UpdateAccountDetails } from './generated/contracts.js';
import { adminUserAccountDetails, ApiError, updateAdminUserAccountDetails } from './api.js';
import { Button } from './kit/components/ui/button.js';
import { Input } from './kit/components/ui/input.js';

interface AccountDetailsForm {
  readonly firstName: string;
  readonly lastName: string;
  readonly birthDate: string;
  readonly phone: string;
  readonly image: string;
}

const blankAccountDetails: AccountDetailsForm = {
  firstName: '',
  lastName: '',
  birthDate: '',
  phone: '',
  image: '',
};

function accountDetailsForm(value: AccountDetails): AccountDetailsForm {
  return {
    firstName: value.firstName ?? '',
    lastName: value.lastName ?? '',
    birthDate: value.birthDate ?? '',
    phone: value.phone ?? '',
    image: value.image ?? '',
  };
}

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
  const queryClient = useQueryClient();
  const back = backState(location.state);
  const validUserId = userId !== undefined && userId.length > 0 && userId.length <= 128;
  const { data, error, isFetching, refetch } = useGetOne<AdminUser>(
    'users',
    { id: userId ?? '' },
    {
      retry: false,
      staleTime: 0,
      enabled: validUserId,
    },
  );
  const accountDetails = useQuery({
    queryKey: ['admin-user-account-details', userId],
    queryFn: ({ signal }) => adminUserAccountDetails(userId ?? '', signal),
    retry: false,
    staleTime: 0,
    enabled: validUserId,
  });
  const [draft, setDraft] = useState<AccountDetailsForm>(blankAccountDetails);
  const [saved, setSaved] = useState(false);
  const update = useMutation({
    mutationFn: (values: UpdateAccountDetails) =>
      updateAdminUserAccountDetails(userId ?? '', values),
    onSuccess: (value) => {
      queryClient.setQueryData(['admin-user-account-details', userId], value);
      setDraft(accountDetailsForm(value));
      setSaved(true);
    },
  });

  useEffect(() => {
    setDraft(blankAccountDetails);
    setSaved(false);
  }, [userId]);

  useEffect(() => {
    if (accountDetails.data !== undefined) setDraft(accountDetailsForm(accountDetails.data));
  }, [accountDetails.data]);

  const saveAccountDetails = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    update.mutate({
      firstName: draft.firstName,
      lastName: draft.lastName,
      birthDate: draft.birthDate.length === 0 ? null : draft.birthDate,
      phone: draft.phone,
      image: draft.image,
    });
  };

  if (!validUserId) {
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
      <section className="account-details-editor" aria-labelledby="account-details-title">
        <h2 id="account-details-title">Datos de cuenta</h2>
        <p className="auth-description">Edita los datos personales opcionales de este usuario.</p>
        {accountDetails.isPending ? (
          <p role="status">Cargando datos de cuenta…</p>
        ) : accountDetails.error !== null ? (
          <div role="alert">
            <p>
              {accountDetails.error instanceof ApiError && accountDetails.error.status === 403
                ? 'No tienes permiso para consultar los datos de cuenta.'
                : 'No pudimos cargar los datos de cuenta. Inténtalo de nuevo.'}
            </p>
            <Button
              onClick={() => {
                void accountDetails.refetch();
              }}
            >
              Reintentar
            </Button>
          </div>
        ) : (
          <form className="account-details-form" onSubmit={saveAccountDetails}>
            <label htmlFor="account-first-name">Nombre</label>
            <Input
              id="account-first-name"
              maxLength={100}
              value={draft.firstName}
              disabled={update.isPending}
              onChange={(event) => {
                setDraft({ ...draft, firstName: event.target.value });
              }}
            />
            <label htmlFor="account-last-name">Apellidos</label>
            <Input
              id="account-last-name"
              maxLength={100}
              value={draft.lastName}
              disabled={update.isPending}
              onChange={(event) => {
                setDraft({ ...draft, lastName: event.target.value });
              }}
            />
            <label htmlFor="account-birth-date">Fecha de nacimiento</label>
            <Input
              id="account-birth-date"
              type="date"
              value={draft.birthDate}
              disabled={update.isPending}
              onChange={(event) => {
                setDraft({ ...draft, birthDate: event.target.value });
              }}
            />
            <label htmlFor="account-phone">Teléfono</label>
            <Input
              id="account-phone"
              type="tel"
              maxLength={40}
              value={draft.phone}
              disabled={update.isPending}
              onChange={(event) => {
                setDraft({ ...draft, phone: event.target.value });
              }}
            />
            <label htmlFor="account-image">Referencia de imagen HTTPS</label>
            <Input
              id="account-image"
              type="url"
              maxLength={2048}
              value={draft.image}
              disabled={update.isPending}
              onChange={(event) => {
                setDraft({ ...draft, image: event.target.value });
              }}
            />
            {update.error !== null && (
              <p role="alert">
                {update.error instanceof ApiError && update.error.status === 400
                  ? 'Revisa la fecha y los datos introducidos.'
                  : update.error instanceof ApiError && update.error.status === 403
                    ? 'No tienes permiso para editar los datos de cuenta.'
                    : 'No pudimos guardar los datos. Inténtalo de nuevo.'}
              </p>
            )}
            {saved && <p role="status">Cambios guardados.</p>}
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </form>
        )}
      </section>
      <p>
        <Link to="/users" state={back}>
          Volver a la lista
        </Link>
      </p>
    </section>
  );
}
