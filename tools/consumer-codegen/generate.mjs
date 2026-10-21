import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

// Scoped TypeScript 5 exception (ADR-0006, ticket #152): the pinned
// openapi-typescript@7.13.0 declares the peer range typescript@^5.x, so this
// isolated workspace pins the supported 5.x version 5.9.3. Isolation permits
// ordinary npm ci without force/legacy-peer overrides; the emitted contracts
// are checked by the application TypeScript 6 toolchain. A declared peer
// restriction is not proof that TypeScript 6 cannot run the generator. The
// desired end state is TypeScript 6 here too; revisit when the generator
// declares TypeScript 6 support, then migrate and remove this exception.
const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  throw new Error('Expected absolute OpenAPI input and generated output paths.');
}
const nodes = await openapiTS(pathToFileURL(input));
await writeFile(output, astToString(nodes));
