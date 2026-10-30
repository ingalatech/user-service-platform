import type { AdminUser } from '../generated/contracts.js';

export interface PrototypeAdministrator {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string;
}

export interface PrototypeSession {
  id: string;
  device: string;
  lastSeen: string;
  location: string;
}

export const prototypeUserTabs = [
  { value: 'resumen', label: 'Resumen' },
  { value: 'acceso', label: 'Acceso' },
  { value: 'sesiones', label: 'Sesiones' },
  { value: 'ciclo-de-vida', label: 'Ciclo de vida' },
  { value: 'actividad', label: 'Actividad' },
] as const;

export function findPrototypeAdministrator(
  id: string | undefined,
): PrototypeAdministrator | undefined {
  return prototypeAdministrators.find((item) => item.id === id);
}

export function prototypeUserActionLabels(email: string) {
  return {
    resendVerification: `Reenviar verificación para ${email}`,
    sendRecovery: `Enviar recuperación a ${email}`,
    revokeSession: `Revocar sesión de ${email}`,
    revokeAllSessions: `Revocar todas las sesiones de ${email}`,
    disableAccount: `Deshabilitar cuenta de ${email}`,
    enableAccount: `Rehabilitar cuenta de ${email}`,
    requestDeletion: `Registrar solicitud de eliminación de ${email}`,
  };
}

export const prototypeSessions: PrototypeSession[] = [
  { id: 'session-current', device: 'Chrome en macOS', lastSeen: 'Ahora', location: 'Londres' },
  {
    id: 'session-mobile',
    device: 'Safari en iPhone',
    lastSeen: 'Hace 2 horas',
    location: 'Londres',
  },
];

export const prototypeActivity = [
  { date: '18 oct 2026, 09:20', event: 'Cuenta creada', detail: 'Registro completado' },
  {
    date: '18 oct 2026, 09:21',
    event: 'Correo verificado',
    detail: 'Correo electrónico confirmado',
  },
  {
    date: '19 oct 2026, 14:10',
    event: 'Datos de cuenta actualizados',
    detail: 'Actualización administrativa',
  },
];

export const prototypeAdministrators: PrototypeAdministrator[] = [
  {
    id: 'administrator-luna',
    email: 'admin@example.com',
    emailVerified: true,
    role: 'admin',
  },
  {
    id: 'administrator-ops',
    email: 'operations@example.com',
    emailVerified: true,
    role: 'admin',
  },
];

export const prototypeSocialProviders: string[] = [];

export const prototypeInvitations = [
  { id: 'invitation-1', email: 'reviewer@example.com', role: 'admin', status: 'Pendiente' },
  { id: 'invitation-2', email: 'support@example.com', role: 'admin', status: 'Aceptada' },
];

export const prototypeAuditEvents = [
  {
    id: 'audit-1',
    action: 'Datos de cuenta actualizados',
    actor: 'admin@example.com',
    target: 'ada@example.com',
    date: '19 oct 2026, 14:10',
  },
  {
    id: 'audit-2',
    action: 'Invitación enviada',
    actor: 'admin@example.com',
    target: 'reviewer@example.com',
    date: '18 oct 2026, 11:45',
  },
  {
    id: 'audit-3',
    action: 'Administrador rehabilitado',
    actor: 'operations@example.com',
    target: 'admin@example.com',
    date: '17 oct 2026, 16:30',
  },
];

export function prototypeUser(record: AdminUser | undefined): AdminUser {
  return (
    record ?? {
      id: 'prototype-user',
      email: 'ada@example.com',
      emailVerified: true,
      realm: 'reader',
      role: 'user',
    }
  );
}
