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

export const prototypeAccountData = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  birthDate: '1815-12-10',
  phone: '+44 20 7946 0958',
  image: 'https://images.example.test/ada.png',
};

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
