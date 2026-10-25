const moduleSpecifierPattern = /\b(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

function isServerOnlyModule(specifier: string): boolean {
  return specifier === 'hono' || specifier.startsWith('hono/') || specifier.startsWith('@hono/');
}

export function assertAdminBrowserSafeImports(source: string, label: string): void {
  const imports = [...source.matchAll(moduleSpecifierPattern)].map((match) => match[1]);
  const forbidden = imports.filter(
    (specifier): specifier is string => specifier !== undefined && isServerOnlyModule(specifier),
  );
  if (forbidden.length > 0) {
    throw new Error(`${label} includes server-only imports: ${forbidden.join(', ')}.`);
  }
}
