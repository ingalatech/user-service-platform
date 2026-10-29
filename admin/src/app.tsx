import { useState, type PropsWithChildren } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CustomRoutes,
  HasDashboardContextProvider,
  memoryStore,
  Resource,
  type CoreLayoutProps,
  useAuthState,
  useGetIdentity,
  useLogout,
} from 'ra-core';
import { Link, Navigate, Route, useNavigate } from 'react-router';
import { Admin } from './kit/components/admin/admin.js';
import { Button } from './kit/components/ui/button.js';
import { authProvider } from './auth-provider.js';
import { AdminMeSchema } from './generated/contracts.js';
import { ApiError } from './api.js';
import { Layout } from './kit/components/admin/layout.js';
import { i18nProvider } from './i18n.js';
import { LoginPage } from './login-page.js';
import { dataProvider } from './data-provider.js';
import { UsersList } from './users-list.js';
import { UsersShow } from './users-show.js';
import { PrototypeAccountAdministration } from './prototype-account-administration.js';

const store = memoryStore();

function SignOutButton() {
  const logout = useLogout();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const click = async () => {
    setPending(true);
    setFailed(false);
    try {
      await logout();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="sign-out-control">
      <Button
        disabled={pending}
        onClick={() => {
          void click();
        }}
      >
        {pending ? 'Cerrando sesión…' : 'Cerrar sesión'}
      </Button>
      {failed && <p role="alert">No pudimos cerrar la sesión. Inténtalo de nuevo.</p>}
    </div>
  );
}

function IdentityLanding() {
  const { data, isPending, error } = useGetIdentity();
  const identity = AdminMeSchema.safeParse(data);
  if (isPending) return <Loading />;
  if (error || !identity.success) return <AuthFailure error={error} />;
  return (
    <section className="identity-card" aria-labelledby="identity-title">
      <p className="eyebrow">ADMINISTRACIÓN</p>
      <h1 id="identity-title">Sesión de administración</h1>
      <p className="auth-description">Tu cuenta tiene acceso al panel.</p>
      <dl>
        <dt>Correo electrónico</dt>
        <dd>{identity.data.email}</dd>
        <dt>Rol</dt>
        <dd>{identity.data.role}</dd>
        <dt>Verificación</dt>
        <dd>{identity.data.emailVerified ? 'Correo verificado' : 'Correo sin verificar'}</dd>
      </dl>
      <SignOutButton />
    </section>
  );
}

function Denied() {
  const navigate = useNavigate();
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1>Acceso denegado</h1>
        <p>Tu cuenta no tiene permiso para acceder a la administración.</p>
        <p className="auth-description">
          Tu sesión sigue activa. Puedes cerrarla para usar otra cuenta.
        </p>
        <SignOutButton />
        <Button
          variant="outline"
          onClick={() => {
            void navigate('/login');
          }}
        >
          Volver al inicio de sesión
        </Button>
      </section>
    </main>
  );
}

function ServiceFailure() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const retry = async () => {
    await queryClient.resetQueries({ queryKey: ['auth'] });
    await navigate('/');
  };
  return (
    <main className="auth-screen">
      <section className="auth-card" role="alert">
        <h1>El servicio no está disponible</h1>
        <p>Tu sesión se conserva. Inténtalo de nuevo en unos instantes.</p>
        <Button
          onClick={() => {
            void retry();
          }}
        >
          Reintentar
        </Button>
      </section>
    </main>
  );
}

function Loading() {
  return (
    <p className="loading-state" role="status">
      Comprobando la sesión…
    </p>
  );
}

function AuthFailure({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;
  if (error instanceof ApiError && error.status === 403) return <Denied />;
  return <ServiceFailure />;
}

function ProtectedNotFound() {
  return (
    <section className="identity-card">
      <h1>Página no encontrada</h1>
      <Link to="/">Volver al inicio</Link>
    </section>
  );
}

// ra-core's requireAuth route logs out on any failed check, including 403/500.
// This application-owned guard preserves those sessions and selects the safe
// view from the authoritative server status, while retaining the kit layout.
function ProtectedView({ children }: PropsWithChildren) {
  const { isPending, error } = useAuthState<ApiError>(undefined, false, { retry: false });
  if (isPending) return <Loading />;
  if (error !== null) return <AuthFailure error={error} />;
  return (
    <HasDashboardContextProvider value={true}>
      <Layout>{children}</Layout>
    </HasDashboardContextProvider>
  );
}

function ProtectedLayout({ children }: CoreLayoutProps) {
  return <ProtectedView>{children}</ProtectedView>;
}

export function App() {
  return (
    <Admin
      title="Administración"
      authProvider={authProvider}
      dataProvider={dataProvider}
      layout={ProtectedLayout}
      catchAll={ProtectedNotFound}
      i18nProvider={i18nProvider}
      store={store}
      disableTelemetry
      loginPage={LoginPage}
      loading={Loading}
      error={ServiceFailure}
      authenticationError={ServiceFailure}
      accessDenied={Denied}
    >
      <Resource name="users" list={UsersList} options={{ label: 'Usuarios' }} />
      <CustomRoutes noLayout>
        <Route
          path="/users/:userId"
          element={
            <ProtectedView>
              <UsersShow />
            </ProtectedView>
          }
        />
        <Route
          path="/prototype/account-administration"
          element={<PrototypeAccountAdministration />}
        />
        <Route
          path="/"
          element={
            <ProtectedView>
              <IdentityLanding />
            </ProtectedView>
          }
        />
        <Route path="/denegado" element={<Denied />} />
      </CustomRoutes>
    </Admin>
  );
}
