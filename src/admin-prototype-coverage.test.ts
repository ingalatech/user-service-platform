import { describe, expect, it } from 'vitest';
import {
  findPrototypeAdministrator,
  prototypeSocialProviders,
  prototypeUserActionLabels,
  prototypeUserTabs,
} from '../admin/src/prototype/prototype-data.js';

describe('account hierarchy prototype contracts', () => {
  it('does not substitute a real administrator for an unknown route id', () => {
    expect(findPrototypeAdministrator('does-not-exist')).toBeUndefined();
    expect(findPrototypeAdministrator(undefined)).toBeUndefined();
  });

  it('keeps the User summary hierarchy in the approved order', () => {
    expect(prototypeUserTabs.map(({ value }) => value)).toEqual([
      'resumen',
      'acceso',
      'sesiones',
      'ciclo-de-vida',
      'actividad',
    ]);
  });

  it('does not offer unlink actions when no provider is linked', () => {
    expect(prototypeSocialProviders).toHaveLength(0);
  });

  it('names destructive actions for the target email', () => {
    const labels = prototypeUserActionLabels('ada@example.com');
    expect(labels.revokeAllSessions).toContain('ada@example.com');
    expect(labels.disableAccount).toContain('ada@example.com');
    expect(labels.requestDeletion).toContain('ada@example.com');
  });
});
