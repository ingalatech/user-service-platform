import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  KeyRound,
  Laptop,
  Mail,
  MoreHorizontal,
  ShieldCheck,
  Smartphone,
  UsersRound,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from './kit/components/ui/button.js';

// Three throwaway account-administration views, switchable via `?variant=` on the prototype route.

type VariantKey = 'workspace' | 'inspector' | 'command';
type SectionKey =
  | 'Resumen'
  | 'Datos de cuenta'
  | 'Acceso y seguridad'
  | 'Estado de cuenta'
  | 'Sesiones'
  | 'Actividad';

const variants: readonly { key: VariantKey; name: string }[] = [
  { key: 'workspace', name: 'Espacio por pestañas' },
  { key: 'inspector', name: 'Inspector dividido' },
  { key: 'command', name: 'Centro de actividad' },
];

const sections: readonly SectionKey[] = [
  'Resumen',
  'Datos de cuenta',
  'Acceso y seguridad',
  'Estado de cuenta',
  'Sesiones',
  'Actividad',
];

const reader = {
  name: 'María García López',
  initials: 'MG',
  email: 'maria.garcia@example.com',
  id: 'usr_01H8M4K7R2Q9',
  joined: '12 ene 2024',
  lastSeen: 'Hace 18 min',
  plan: 'Premium anual',
};

const sessions = [
  { device: 'MacBook Pro', location: 'Madrid, ES', when: 'Ahora', current: true, icon: Laptop },
  {
    device: 'iPhone 15',
    location: 'Madrid, ES',
    when: 'Hace 2 h',
    current: false,
    icon: Smartphone,
  },
  {
    device: 'Chrome en Windows',
    location: 'Valencia, ES',
    when: 'Hace 3 días',
    current: false,
    icon: Laptop,
  },
];

const activity = [
  {
    date: 'Hoy, 09:42',
    title: 'Inicio de sesión correcto',
    detail: 'MacBook Pro · Madrid, ES',
    tone: 'good',
  },
  {
    date: 'Ayer, 16:18',
    title: 'Correo de acceso reenviado',
    detail: 'Solicitado por administración',
    tone: 'neutral',
  },
  {
    date: '18 jun, 11:05',
    title: 'Contraseña actualizada',
    detail: 'Desde la cuenta del Reader',
    tone: 'neutral',
  },
  {
    date: '02 jun, 08:30',
    title: 'Cuenta creada',
    detail: 'Registro con correo y contraseña',
    tone: 'neutral',
  },
];

function StatusPill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'good' | 'warning' | 'neutral';
}) {
  return <span className={`prototype-pill prototype-pill-${tone}`}>{children}</span>;
}

function AccountNav({
  active,
  onSelect,
}: {
  active: SectionKey;
  onSelect?: (section: SectionKey) => void;
}) {
  return (
    <nav className="prototype-section-nav" aria-label="Secciones de la cuenta">
      <p className="prototype-nav-label">Esta cuenta</p>
      {sections.map((section) => (
        <button
          className={active === section ? 'prototype-nav-item is-active' : 'prototype-nav-item'}
          key={section}
          onClick={() => onSelect?.(section)}
          type="button"
        >
          {section}
          {section === 'Acceso y seguridad' && <StatusPill tone="warning">2</StatusPill>}
        </button>
      ))}
      <div className="prototype-nav-divider" />
      <p className="prototype-nav-label">Administración</p>
      <button className="prototype-nav-item" type="button">
        <UsersRound size={15} /> Administradores
      </button>
      <button className="prototype-nav-item" type="button">
        <Mail size={15} /> Invitaciones <StatusPill>3</StatusPill>
      </button>
    </nav>
  );
}

function ReaderHeader({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'prototype-reader-head is-compact' : 'prototype-reader-head'}>
      <div className="prototype-avatar">{reader.initials}</div>
      <div className="prototype-reader-heading">
        <div className="prototype-kicker">READER · {reader.id}</div>
        <h1>{reader.name}</h1>
        <p>{reader.email}</p>
      </div>
      <div className="prototype-head-status">
        <StatusPill tone="good">
          <Check size={13} /> Activa
        </StatusPill>
        <button className="prototype-icon-button" type="button" aria-label="Más opciones">
          <MoreHorizontal size={19} />
        </button>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  variant = 'outline',
  onClick,
}: {
  children: ReactNode;
  variant?: 'outline' | 'destructive' | 'default';
  onClick?: () => void;
}) {
  return (
    <Button onClick={onClick} size="sm" variant={variant}>
      {children}
    </Button>
  );
}

function AccountSummary() {
  return (
    <div className="prototype-summary-grid">
      <div>
        <span>Estado</span>
        <strong>
          <StatusPill tone="good">Activa</StatusPill>
        </strong>
      </div>
      <div>
        <span>Alta</span>
        <strong>{reader.joined}</strong>
      </div>
      <div>
        <span>Última actividad</span>
        <strong>{reader.lastSeen}</strong>
      </div>
      <div>
        <span>Suscripción</span>
        <strong>{reader.plan}</strong>
      </div>
    </div>
  );
}

function OverviewPanel({ onSelect }: { onSelect: (section: SectionKey) => void }) {
  return (
    <div className="prototype-panel-stack">
      <section className="prototype-panel prototype-panel-emphasis">
        <div className="prototype-panel-title">
          <div>
            <p className="prototype-kicker">LECTURA RÁPIDA</p>
            <h2>La cuenta está operativa</h2>
          </div>
          <ShieldCheck size={26} />
        </div>
        <p className="prototype-muted">
          No hay bloqueos ni alertas de acceso. La última sesión coincide con el dispositivo
          habitual.
        </p>
        <AccountSummary />
      </section>
      <div className="prototype-two-up">
        <section className="prototype-panel">
          <div className="prototype-panel-title">
            <h2>Acceso y seguridad</h2>
            <KeyRound size={18} />
          </div>
          <p className="prototype-muted">Correo verificado · contraseña actualizada hace 18 días</p>
          <ActionButton
            onClick={() => {
              onSelect('Acceso y seguridad');
            }}
          >
            Revisar seguridad
          </ActionButton>
        </section>
        <section className="prototype-panel">
          <div className="prototype-panel-title">
            <h2>Sesiones</h2>
            <Laptop size={18} />
          </div>
          <p className="prototype-muted">3 sesiones activas · 1 en este dispositivo</p>
          <ActionButton
            onClick={() => {
              onSelect('Sesiones');
            }}
          >
            Ver sesiones
          </ActionButton>
        </section>
      </div>
    </div>
  );
}

function AccountDataPanel() {
  return (
    <section className="prototype-panel">
      <div className="prototype-panel-title">
        <div>
          <p className="prototype-kicker">PERFIL</p>
          <h2>Datos de cuenta</h2>
        </div>
        <ActionButton>Editar</ActionButton>
      </div>
      <dl className="prototype-definition-grid">
        <dt>Nombre</dt>
        <dd>María García López</dd>
        <dt>Correo electrónico</dt>
        <dd>
          {reader.email} <StatusPill tone="good">Verificado</StatusPill>
        </dd>
        <dt>Teléfono</dt>
        <dd>+34 612 445 890</dd>
        <dt>Fecha de nacimiento</dt>
        <dd>14 de marzo de 1991</dd>
      </dl>
    </section>
  );
}

function SecurityPanel({ onAction }: { onAction: (label: string, critical?: boolean) => void }) {
  return (
    <div className="prototype-panel-stack">
      <section className="prototype-panel">
        <div className="prototype-panel-title">
          <div>
            <p className="prototype-kicker">CREDENCIALES</p>
            <h2>Acceso y seguridad</h2>
          </div>
          <StatusPill tone="good">Protegida</StatusPill>
        </div>
        <div className="prototype-action-list">
          <div>
            <div>
              <strong>Contraseña</strong>
              <p className="prototype-muted">Actualizada hace 18 días</p>
            </div>
            <ActionButton
              onClick={() => {
                onAction('restablecer contraseña');
              }}
            >
              Restablecer
            </ActionButton>
          </div>
          <div>
            <div>
              <strong>Correo de acceso</strong>
              <p className="prototype-muted">{reader.email}</p>
            </div>
            <ActionButton
              onClick={() => {
                onAction('reenviar correo');
              }}
            >
              Reenviar
            </ActionButton>
          </div>
        </div>
      </section>
      <section className="prototype-panel">
        <div className="prototype-panel-title">
          <div>
            <h2>Proveedores vinculados</h2>
            <p className="prototype-muted">Google · vinculado el 12 ene 2024</p>
          </div>
          <StatusPill>1 proveedor</StatusPill>
        </div>
        <div className="prototype-critical">
          <AlertTriangle size={17} />
          <div>
            <strong>Desvincular Google</strong>
            <p>Es irreversible y puede dejar a la persona sin método de acceso.</p>
          </div>
          <ActionButton
            variant="destructive"
            onClick={() => {
              onAction('desvincular Google', true);
            }}
          >
            Desvincular
          </ActionButton>
        </div>
      </section>
    </div>
  );
}

function AccountStatePanel({
  onAction,
}: {
  onAction: (label: string, critical?: boolean) => void;
}) {
  return (
    <section className="prototype-panel">
      <div className="prototype-panel-title">
        <div>
          <p className="prototype-kicker">CONTROL OPERATIVO</p>
          <h2>Estado de cuenta</h2>
        </div>
        <StatusPill tone="good">Activa</StatusPill>
      </div>
      <div className="prototype-state-banner">
        <Check size={18} />
        <div>
          <strong>Puede iniciar sesión</strong>
          <p className="prototype-muted">Sin solicitud de eliminación ni restricciones manuales.</p>
        </div>
      </div>
      <div className="prototype-button-row">
        <ActionButton
          onClick={() => {
            onAction('deshabilitar cuenta');
          }}
        >
          Deshabilitar cuenta
        </ActionButton>
        <ActionButton
          variant="outline"
          onClick={() => {
            onAction('solicitar eliminación');
          }}
        >
          Solicitar eliminación
        </ActionButton>
      </div>
    </section>
  );
}

function SessionsPanel({ onAction }: { onAction: (label: string, critical?: boolean) => void }) {
  return (
    <section className="prototype-panel">
      <div className="prototype-panel-title">
        <div>
          <p className="prototype-kicker">CONTROL DE SESIONES</p>
          <h2>Sesiones</h2>
        </div>
        <ActionButton
          onClick={() => {
            onAction('cerrar otras sesiones');
          }}
        >
          Cerrar otras
        </ActionButton>
      </div>
      <div className="prototype-session-list">
        {sessions.map(({ device, location, when, current, icon: Icon }) => (
          <div className="prototype-session-row" key={device}>
            <Icon size={18} />
            <div>
              <strong>
                {device} {current && <StatusPill tone="good">Este dispositivo</StatusPill>}
              </strong>
              <p className="prototype-muted">
                {location} · {when}
              </p>
            </div>
            {!current && (
              <ActionButton
                onClick={() => {
                  onAction(`cerrar sesión en ${device}`);
                }}
              >
                Cerrar sesión
              </ActionButton>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityPanel() {
  return (
    <section className="prototype-panel">
      <div className="prototype-panel-title">
        <div>
          <p className="prototype-kicker">REGISTRO DURABLE</p>
          <h2>Actividad</h2>
        </div>
        <ActionButton>Exportar</ActionButton>
      </div>
      <div className="prototype-timeline">
        {activity.map((item) => (
          <div className="prototype-timeline-item" key={item.date + item.title}>
            <span className={`prototype-timeline-dot ${item.tone}`} />
            <div>
              <p className="prototype-timeline-date">{item.date}</p>
              <strong>{item.title}</strong>
              <p className="prototype-muted">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: VariantKey;
  onChange: (key: VariantKey) => void;
}) {
  const index = variants.findIndex((variant) => variant.key === current);
  const selected = variants[index] ?? {
    key: 'workspace' as VariantKey,
    name: 'Espacio por pestañas',
  };
  const move = (offset: number) => {
    const next = variants[(index + offset + variants.length) % variants.length];
    if (next !== undefined) onChange(next.key);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });
  if (import.meta.env.PROD) return null;
  return (
    <div className="prototype-switcher" aria-label="Cambiar variante">
      <button
        type="button"
        onClick={() => {
          move(-1);
        }}
        aria-label="Variante anterior"
      >
        <ArrowLeft size={16} />
      </button>
      <span>
        <b>{current}</b> · {selected.name}
      </span>
      <button
        type="button"
        onClick={() => {
          move(1);
        }}
        aria-label="Variante siguiente"
      >
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

function usePrototypeActions() {
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const action = (label: string, critical = false) => {
    if (critical) setWarning(label);
    else if (label === 'restablecer contraseña' || label === 'reenviar correo')
      setNotice(`Demo: ${label} listo para conectar.`);
    else if (window.confirm(`¿Confirmar ${label}?`)) setNotice(`Demo: ${label} confirmado.`);
  };
  const warningPanel =
    warning === '' ? null : (
      <div className="prototype-modal-note" role="alert">
        <AlertTriangle size={19} />
        <div>
          <strong>Acción irreversible</strong>
          <p>
            Desvincular Google puede eliminar el único método de acceso de María. Esta acción no se
            puede deshacer.
          </p>
          <div className="prototype-button-row">
            <ActionButton
              onClick={() => {
                setWarning('');
                setNotice('Demo: proveedor Google desvinculado.');
              }}
            >
              Entiendo, desvincular
            </ActionButton>
            <ActionButton
              variant="outline"
              onClick={() => {
                setWarning('');
              }}
            >
              Cancelar
            </ActionButton>
          </div>
        </div>
        <button
          className="prototype-dismiss"
          type="button"
          onClick={() => {
            setWarning('');
          }}
          aria-label="Cerrar advertencia"
        >
          <X size={16} />
        </button>
      </div>
    );
  return { action, notice, warningPanel };
}

function WorkspaceVariant() {
  const [active, setActive] = useState<SectionKey>('Resumen');
  const { action, notice, warningPanel } = usePrototypeActions();
  return (
    <div className="prototype-page prototype-workspace">
      <div className="prototype-page-intro">
        <a href="/admin/#/users">
          <ArrowLeft size={15} /> Usuarios
        </a>
        <span className="prototype-kicker">PROTOTIPO · CUENTA DEL READER</span>
      </div>
      <ReaderHeader />
      <div className="prototype-tab-bar">
        {sections.map((section) => (
          <button
            className={active === section ? 'is-active' : ''}
            key={section}
            onClick={() => {
              setActive(section);
            }}
            type="button"
          >
            {section}
          </button>
        ))}
      </div>
      <div className="prototype-tab-layout">
        <AccountNav active={active} onSelect={setActive} />
        <main className="prototype-tab-content">
          {active === 'Resumen' && <OverviewPanel onSelect={setActive} />}
          {active === 'Datos de cuenta' && <AccountDataPanel />}
          {active === 'Acceso y seguridad' && <SecurityPanel onAction={action} />}
          {active === 'Estado de cuenta' && <AccountStatePanel onAction={action} />}
          {active === 'Sesiones' && <SessionsPanel onAction={action} />}
          {active === 'Actividad' && <ActivityPanel />}
        </main>
      </div>
      {notice && (
        <p className="prototype-toast" role="status">
          {notice}
        </p>
      )}
      {warningPanel}
    </div>
  );
}

function InspectorVariant() {
  const [active, setActive] = useState<SectionKey>('Acceso y seguridad');
  const { action, notice, warningPanel } = usePrototypeActions();
  const panel =
    active === 'Datos de cuenta' ? (
      <AccountDataPanel />
    ) : active === 'Acceso y seguridad' ? (
      <SecurityPanel onAction={action} />
    ) : active === 'Estado de cuenta' ? (
      <AccountStatePanel onAction={action} />
    ) : active === 'Sesiones' ? (
      <SessionsPanel onAction={action} />
    ) : active === 'Actividad' ? (
      <ActivityPanel />
    ) : (
      <OverviewPanel onSelect={setActive} />
    );
  return (
    <div className="prototype-page prototype-inspector">
      <div className="prototype-command-strip">
        <div>
          <span className="prototype-kicker">ADMINISTRACIÓN / READER</span>
          <h1>Cuenta de María García</h1>
        </div>
        <div className="prototype-strip-links">
          <button type="button">
            <UsersRound size={15} /> Administradores
          </button>
          <button type="button">
            <Mail size={15} /> Invitaciones <StatusPill>3</StatusPill>
          </button>
        </div>
      </div>
      <div className="prototype-inspector-layout">
        <aside className="prototype-account-rail">
          <ReaderHeader compact />
          <AccountSummary />
          <AccountNav active={active} onSelect={setActive} />
        </aside>
        <main className="prototype-inspector-main">
          <div className="prototype-breadcrumb">
            <a href="/admin/#/users">Usuarios</a>
            <ChevronDown size={13} />
            <span>{active}</span>
          </div>
          <div className="prototype-task-heading">
            <div>
              <p className="prototype-kicker">TAREA ABIERTA</p>
              <h2>{active}</h2>
            </div>
            <StatusPill tone="warning">Requiere revisión</StatusPill>
          </div>
          {panel}
        </main>
        <aside className="prototype-inspector-side">
          <p className="prototype-kicker">CONTEXTO</p>
          <h2>Estado de sesión</h2>
          <div className="prototype-side-stat">
            <strong>3</strong>
            <span>sesiones activas</span>
          </div>
          <div className="prototype-side-stat">
            <strong>0</strong>
            <span>bloqueos</span>
          </div>
          <div className="prototype-side-note">
            <Clock3 size={16} />
            <span>
              Última actividad
              <br />
              <strong>Hoy, 09:42</strong>
            </span>
          </div>
          <p className="prototype-muted">
            El inspector mantiene el contexto visible mientras resuelves una tarea.
          </p>
        </aside>
      </div>
      {notice && (
        <p className="prototype-toast" role="status">
          {notice}
        </p>
      )}
      {warningPanel}
    </div>
  );
}

function CommandVariant() {
  const { action, notice, warningPanel } = usePrototypeActions();
  return (
    <div className="prototype-page prototype-command">
      <header className="prototype-command-header">
        <div>
          <span className="prototype-kicker">CENTRO DE CONTROL · PROTOTIPO</span>
          <h1>María García López</h1>
          <p>
            {reader.email} · {reader.id}
          </p>
        </div>
        <div className="prototype-header-actions">
          <StatusPill tone="good">
            <Check size={13} /> Cuenta activa
          </StatusPill>
          <ActionButton
            onClick={() => {
              action('deshabilitar cuenta');
            }}
          >
            Deshabilitar
          </ActionButton>
        </div>
      </header>
      <div className="prototype-command-grid">
        <aside className="prototype-command-sidebar">
          <div className="prototype-command-avatar">{reader.initials}</div>
          <h2>Estado de cuenta</h2>
          <StatusPill tone="good">Sin alertas</StatusPill>
          <AccountSummary />
          <div className="prototype-command-nav">
            <a href="#resumen">Resumen</a>
            <a href="#datos">Datos de cuenta</a>
            <a href="#seguridad">Acceso y seguridad</a>
            <a href="#estado">Estado de cuenta</a>
            <a href="#sesiones">Sesiones</a>
            <a href="#actividad">Actividad</a>
          </div>
          <div className="prototype-command-nav prototype-admin-nav">
            <p className="prototype-kicker">ADMINISTRACIÓN</p>
            <a href="#administradores">
              <UsersRound size={15} /> Administradores
            </a>
            <a href="#invitaciones">
              <Mail size={15} /> Invitaciones <StatusPill>3 pendientes</StatusPill>
            </a>
          </div>
        </aside>
        <main className="prototype-command-main">
          <section className="prototype-command-hero" id="resumen">
            <div>
              <p className="prototype-kicker">RESUMEN OPERATIVO</p>
              <h2>Todo está en orden</h2>
              <p className="prototype-muted">
                La actividad reciente no muestra señales de riesgo. El siguiente control recomendado
                es revisar las sesiones abiertas.
              </p>
            </div>
            <div className="prototype-hero-metric">
              <strong>98</strong>
              <span>salud de cuenta</span>
            </div>
          </section>
          <section className="prototype-command-actions" id="seguridad">
            <div className="prototype-panel-title">
              <div>
                <p className="prototype-kicker">ACCIONES FRECUENTES</p>
                <h2>Resolver sin perder contexto</h2>
              </div>
              <span className="prototype-muted">Acciones de bajo riesgo primero</span>
            </div>
            <div className="prototype-command-action-row">
              <button
                type="button"
                onClick={() => {
                  action('restablecer contraseña');
                }}
              >
                <KeyRound size={18} />
                <span>
                  <strong>Restablecer contraseña</strong>
                  <small>Rutina · sin confirmación</small>
                </span>
                <ArrowRight size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  action('reenviar correo');
                }}
              >
                <Mail size={18} />
                <span>
                  <strong>Reenviar correo de acceso</strong>
                  <small>Rutina · sin confirmación</small>
                </span>
                <ArrowRight size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  action('cerrar otras sesiones');
                }}
              >
                <Laptop size={18} />
                <span>
                  <strong>Revocar otras sesiones</strong>
                  <small>Confirmación simple</small>
                </span>
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
          <div className="prototype-command-lower">
            <section className="prototype-panel" id="actividad">
              <div className="prototype-panel-title">
                <div>
                  <p className="prototype-kicker">ACTIVIDAD</p>
                  <h2>Línea de tiempo</h2>
                </div>
                <StatusPill>4 eventos</StatusPill>
              </div>
              <div className="prototype-timeline">
                {activity.map((item) => (
                  <div className="prototype-timeline-item" key={item.date + item.title}>
                    <span className={`prototype-timeline-dot ${item.tone}`} />
                    <div>
                      <p className="prototype-timeline-date">{item.date}</p>
                      <strong>{item.title}</strong>
                      <p className="prototype-muted">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="prototype-panel" id="sesiones">
              <div className="prototype-panel-title">
                <div>
                  <p className="prototype-kicker">SESIONES</p>
                  <h2>Dispositivos recientes</h2>
                </div>
                <StatusPill tone="warning">1 revisión</StatusPill>
              </div>
              {sessions.map(({ device, location, when, current, icon: Icon }) => (
                <div className="prototype-mini-session" key={device}>
                  <Icon size={17} />
                  <span>
                    <strong>{device}</strong>
                    <small>
                      {location} · {when}
                    </small>
                  </span>
                  {current ? (
                    <StatusPill tone="good">Actual</StatusPill>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        action(`cerrar sesión en ${device}`);
                      }}
                    >
                      Revocar
                    </button>
                  )}
                </div>
              ))}
            </section>
          </div>
        </main>
      </div>
      {notice && (
        <p className="prototype-toast" role="status">
          {notice}
        </p>
      )}
      {warningPanel}
    </div>
  );
}

export function PrototypeAccountAdministration() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('variant');
  const current: VariantKey = variants.some((variant) => variant.key === raw)
    ? (raw as VariantKey)
    : 'workspace';
  const changeVariant = (key: VariantKey) => {
    setParams({ variant: key });
  };
  return (
    <>
      <div className="prototype-shell">
        {current === 'workspace' && <WorkspaceVariant />}
        {current === 'inspector' && <InspectorVariant />}
        {current === 'command' && <CommandVariant />}
      </div>
      <PrototypeSwitcher current={current} onChange={changeVariant} />
    </>
  );
}
