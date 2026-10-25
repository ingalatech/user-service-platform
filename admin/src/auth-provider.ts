import type { AuthProvider, UserIdentity } from 'ra-core';
import type { AdminMe } from './generated/contracts.js';
import { adminIdentity, ApiError, login, signOut } from './api.js';

export type AdminIdentity = AdminMe & UserIdentity;

export const authProvider: AuthProvider = {
  login,
  logout: signOut,
  checkAuth: async () => {
    await adminIdentity();
  },
  checkError: (error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  },
  getIdentity: async (): Promise<AdminIdentity> => {
    const identity = await adminIdentity();
    return { ...identity, fullName: identity.email };
  },
  getPermissions: async (): Promise<string> => (await adminIdentity()).role,
};
