// Single source for OpenAPI document metadata. Both the runtime doc endpoint
// (`app.doc`) and the committed `openapi/openapi.json` artifact derive from this
// config plus the feature route registrations, so documentation cannot drift from
// behaviour (ADR-0007).
export const openApiConfig = {
  openapi: '3.1.0',
  info: {
    title: 'User Service API',
    version: '0.0.0',
    description:
      'Reusable user-service foundation for content-oriented web products. ' +
      'Public operations are namespaced under /v1; the no-name email registration transition is /v2/auth/register.',
  },
} as const;
