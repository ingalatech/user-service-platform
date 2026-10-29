import { useGetOne, useSaveContext } from 'ra-core';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import type { AdminUser } from './generated/contracts.js';
import { ApiError } from './api.js';
import { Edit } from './kit/components/admin/edit.js';
import { CancelButton } from './kit/components/admin/cancel-button.js';
import { SaveButton } from './kit/components/admin/form.js';
import { FormToolbar } from './kit/components/admin/simple-form.js';
import { RecordField } from './kit/components/admin/record-field.js';
import { SimpleForm } from './kit/components/admin/simple-form.js';
import { TextInput } from './kit/components/admin/text-input.js';
import { Button } from './kit/components/ui/button.js';

function EditState({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-4 py-4" aria-labelledby="user-edit-title">
      <h1 id="user-edit-title" className="text-2xl font-bold tracking-tight">
        Editar datos de cuenta
      </h1>
      {children}
    </section>
  );
}

function AccountDetailsForm({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const { save } = useSaveContext();
  const saveForm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const form = event.currentTarget.form;
    if (form === null) return;
    const formData = new FormData(form);
    const value = (source: string) => {
      const entry = formData.get(source);
      return typeof entry === 'string' ? entry : '';
    };
    try {
      await save?.(
        {
          firstName: value('firstName'),
          lastName: value('lastName'),
          birthDate: value('birthDate') || null,
          phone: value('phone'),
          image: value('image'),
        },
        { onSuccess: onSaved, onError },
      );
    } catch (error) {
      onError(error);
    }
  };
  return (
    <SimpleForm
      toolbar={
        <FormToolbar>
          <CancelButton />
          <SaveButton
            type="button"
            label="Guardar cambios"
            onClick={(event) => {
              void saveForm(event);
            }}
          />
        </FormToolbar>
      }
    >
      <TextInput source="firstName" label="Nombre" maxLength={100} />
      <TextInput source="lastName" label="Apellidos" maxLength={100} />
      <TextInput source="birthDate" label="Fecha de nacimiento" type="date" />
      <TextInput source="phone" label="Teléfono" type="tel" maxLength={40} />
      <TextInput source="image" label="Referencia de imagen HTTPS" type="url" maxLength={2048} />
    </SimpleForm>
  );
}

export function UsersEdit() {
  const { id } = useParams();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const validId = id !== undefined && id.length > 0 && id.length <= 128;
  const query = useGetOne<AdminUser>(
    'users',
    { id: id ?? '' },
    { enabled: validId, retry: false, staleTime: 0 },
  );

  if (!validId) {
    return (
      <EditState>
        <div role="alert">
          <h2>Solicitud inválida</h2>
          <p>Revisa el identificador del usuario.</p>
        </div>
      </EditState>
    );
  }

  if (query.isPending || query.isFetching) {
    return (
      <EditState>
        <p role="status">Cargando datos de cuenta…</p>
      </EditState>
    );
  }

  if (query.error !== null) {
    if (query.error instanceof ApiError && query.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <EditState>
          <div role="alert">
            <h2>Acceso denegado</h2>
            <p>Tu cuenta no tiene permiso para editar los datos de cuenta.</p>
          </div>
        </EditState>
      );
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <EditState>
          <div role="alert">
            <h2>Usuario no encontrado</h2>
            <p>No existe ningún usuario con este identificador.</p>
          </div>
        </EditState>
      );
    }
    return (
      <EditState>
        <div role="alert">
          <h2>No pudimos cargar los datos de cuenta</h2>
          <p>Tu sesión se conserva. Inténtalo de nuevo en unos instantes.</p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            Reintentar
          </Button>
        </div>
      </EditState>
    );
  }

  return (
    <Edit
      title="Editar datos de cuenta"
      actions={false}
      redirect={false}
      mutationMode="pessimistic"
      queryOptions={{ enabled: false, initialData: query.data }}
      mutationOptions={{
        onSuccess: () => {
          setSaveError(null);
          setSaved(true);
        },
        onError: (error) => {
          setSaved(false);
          setSaveError(error);
        },
      }}
    >
      <RecordField source="email" label="Correo electrónico" />
      {saveError !== null && (
        <p role="alert">
          {saveError instanceof ApiError && saveError.status === 400
            ? 'Revisa la fecha y los datos introducidos.'
            : saveError instanceof ApiError && saveError.status === 403
              ? 'No tienes permiso para editar los datos de cuenta.'
              : 'No pudimos guardar los datos. Inténtalo de nuevo.'}
        </p>
      )}
      {saved && <p role="status">Cambios guardados.</p>}
      <AccountDetailsForm
        onSaved={() => {
          setSaveError(null);
          setSaved(true);
        }}
        onError={(error) => {
          setSaved(false);
          setSaveError(error);
        }}
      />
    </Edit>
  );
}
