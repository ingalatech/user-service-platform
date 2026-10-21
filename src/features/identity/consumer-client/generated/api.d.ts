export interface paths {
    "/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Service liveness
         * @description Lightweight liveness probe. It proves the Worker and router are running without touching D1 or any other dependency.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register an email identity
         * @description Creates an unverified email/password identity when the deployment policy allows registration, and schedules a verification message through the application mail boundary. The account cannot establish a session until verification succeeds while the policy requires verified email.
         */
        post: operations["registerIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Establish an email/password session
         * @description Authenticates an email/password identity. While the deployment policy requires verified email, unverified accounts receive a machine-readable verification-required failure instead of a session.
         */
        post: operations["loginIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/verify-email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete email verification
         * @description Marks the email address verified from the token delivered by the verification action. Clients extract the `token` query parameter from the action URL and submit it here. Invalid or expired actions fail safely without revealing token material.
         */
        post: operations["verifyIdentityEmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/request-verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a verification message
         * @description Schedules a fresh verification message for an unverified email address without creating duplicate identities. The response is identical whether or not the address is registered, so it cannot be used for account enumeration.
         */
        post: operations["requestIdentityVerification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/request-password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request password recovery
         * @description Schedules a password-reset message for the account matching the email address without creating identities. The response is identical whether or not the address is registered, so it cannot be used for account enumeration.
         */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete password reset
         * @description Sets a new password from the token delivered by the password-reset action. Reset actions are single use and expire. Successful resets revoke existing sessions. Invalid, expired, reused, or malformed actions fail safely without revealing token material.
         */
        post: operations["resetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Resolve the current User
         * @description Returns the stable application-owned current-User representation for the session carried by the request cookies. Anonymous or invalid sessions receive the standard unauthenticated Problem Details response.
         */
        get: operations["getCurrentUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sign-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invalidate the current session
         * @description Invalidates the session carried by the request cookies. Subsequent authenticated-only requests with that session no longer resolve a User.
         */
        post: operations["signOutIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue or renew a consumer access token
         * @description Issues or renews a short-lived application-owned access token from the live HttpOnly cookie session. The request carries no user, claims, issuer or audience: the token holds the opaque session subject, the deployment-configured issuer/audience, integer issued/expiry bounds and an empty entitlements list. Expiry never exceeds the live session expiry. Revoked or expired sessions are denied further issuance; already-issued offline tokens remain valid until their own expiry (at most 15 minutes initially). All responses are private, no-store.
         */
        post: operations["issueConsumerToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/jwks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Publish consumer token verification keys
         * @description Returns the active and retained public asymmetric verification keys as an RFC 7517 JSON Web Key Set. Private key material is never published. Responses carry bounded public caching; verification keys remain available through every outstanding token lifetime plus the documented clock tolerance.
         */
        get: operations["getConsumerJwks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Resolve the current administrator
         * @description Returns the exact administrative representation for the session carried by the request cookies when that session holds User listing/read access. Anonymous or invalid sessions receive the standard unauthenticated Problem Details response; valid non-administrative sessions receive the forbidden Problem Details response. The public `/v1/me` representation is unchanged by this operation.
         */
        get: operations["getAdminMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Users for administrators
         * @description Returns the stable application-owned administrative User representation in ascending email order with bounded server pagination and optional case-insensitive literal email substring search. Anonymous or invalid sessions receive the standard unauthenticated Problem Details response; valid non-administrative sessions receive the forbidden Problem Details response. The `total` counts all matches before pagination.
         */
        get: operations["listAdminUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read one User for administrators
         * @description Returns the stable application-owned administrative User representation for one opaque identifier. Anonymous or invalid sessions receive the standard unauthenticated Problem Details response; valid non-administrative sessions receive the forbidden Problem Details response even when the identifier does not exist. Authorized missing Users receive the not-found Problem Details response.
         */
        get: operations["getAdminUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/admin/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Bootstrap the first administrator
         * @description Creates the first administrative User through the auth engine after migrations, using explicit operator-supplied credentials. Succeeds only while no administrator exists; repeats and conflicting identities fail with stable machine codes instead of duplicating privileged accounts. The bootstrapped administrator remains subject to the deployment email verification policy before signing in.
         */
        post: operations["bootstrapAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        HealthResponse: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
            /** @example user-service */
            service: string;
            /** @example v1 */
            version: string;
            /**
             * Format: date-time
             * @example 2026-09-10T00:00:00.000Z
             */
            now: string;
        };
        ProblemDetails: {
            /** @example urn:problem:not-found */
            type: string;
            /** @example Not Found */
            title: string;
            /** @example 404 */
            status: number;
            /** @example No such operation. */
            detail?: string;
            /** @example not-found */
            code: string;
            /** @example /v1/does-not-exist */
            instance?: string;
        };
        RegisteredUser: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example false */
            emailVerified: boolean;
        };
        RegisterRequest: {
            /** @example Ada Lovelace */
            name: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example correct-horse-41 */
            password: string;
        };
        LoginResult: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example true */
            emailVerified: boolean;
        };
        LoginRequest: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example correct-horse-41 */
            password: string;
        };
        VerifyEmailResult: {
            /**
             * @example true
             * @enum {boolean}
             */
            emailVerified: true;
        };
        VerifyEmailRequest: {
            /** @description Verification token from the action URL. */
            token: string;
        };
        RequestVerificationResult: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
        };
        RequestVerificationRequest: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
        };
        RequestPasswordResetResult: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
        };
        RequestPasswordResetRequest: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
        };
        ResetPasswordResult: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
        };
        ResetPasswordRequest: {
            /** @description Password-reset token from the action URL. */
            token: string;
            /** @example correct-horse-41 */
            newPassword: string;
        };
        CurrentUser: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example true */
            emailVerified: boolean;
        };
        SignOutResult: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
        };
        ConsumerToken: {
            /**
             * @description Short-lived application-owned access token.
             * @example eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhYmMxMjMifQ.sig
             */
            accessToken: string;
            /**
             * @example Bearer
             * @enum {string}
             */
            tokenType: "Bearer";
            /**
             * @description Token expiry as integer Unix seconds.
             * @example 1790000900
             */
            expiresAt: number;
        };
        ConsumerJwks: {
            /** @description Active and retained public verification keys. */
            keys: components["schemas"]["ConsumerJsonWebKey"][];
        };
        ConsumerJsonWebKey: {
            /**
             * @description Stable durable key id.
             * @example abc123
             */
            kid: string;
            /**
             * @description Key type.
             * @example OKP
             */
            kty: string;
            /**
             * @description Fixed supported algorithm.
             * @example EdDSA
             */
            alg: string;
            /**
             * @description Intended use.
             * @example sig
             */
            use?: string;
            /**
             * @description Curve name.
             * @example Ed25519
             */
            crv?: string;
            /** @description Public x coordinate. */
            x?: string;
            /** @description Public y coordinate. */
            y?: string;
            /** @description Public RSA modulus. */
            n?: string;
            /** @description Public RSA exponent. */
            e?: string;
        };
        AdminMe: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example true */
            emailVerified: boolean;
            /** @example admin */
            role: string;
        };
        AdminUserList: {
            /** @description Ascending email order. */
            items: components["schemas"]["AdminUser"][];
            /**
             * @description Matches before pagination.
             * @example 42
             */
            total: number;
        };
        AdminUser: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example true */
            emailVerified: boolean;
            /** @example admin */
            role: string;
        };
        AdminBootstrapResult: {
            /** @example abc123 */
            id: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /**
             * @example admin
             * @enum {string}
             */
            role: "admin";
            /** @example false */
            emailVerified: boolean;
        };
        AdminBootstrapRequest: {
            /** @example Ada Lovelace */
            name: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example correct-horse-41 */
            password: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The Worker is running. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
            /** @description Unexpected failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    registerIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RegisterRequest"];
            };
        };
        responses: {
            /** @description The identity was created (unverified). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredUser"];
                };
            };
            /** @description Registration failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    loginIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Authenticated. The session travels in the Set-Cookie header. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResult"];
                };
            };
            /** @description Authentication failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    verifyIdentityEmail: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["VerifyEmailRequest"];
            };
        };
        responses: {
            /** @description The email address is verified. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerifyEmailResult"];
                };
            };
            /** @description Verification failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    requestIdentityVerification: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RequestVerificationRequest"];
            };
        };
        responses: {
            /** @description The request was accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RequestVerificationResult"];
                };
            };
            /** @description Request failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RequestPasswordResetRequest"];
            };
        };
        responses: {
            /** @description The request was accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RequestPasswordResetResult"];
                };
            };
            /** @description Request failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    resetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /** @description The password was reset. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResetPasswordResult"];
                };
            };
            /** @description Reset failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    getCurrentUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The authenticated current User. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CurrentUser"];
                };
            };
            /** @description Authentication failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    signOutIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session was invalidated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignOutResult"];
                };
            };
            /** @description Sign-out failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    issueConsumerToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The access token, its type and its integer Unix expiry. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsumerToken"];
                };
            };
            /** @description Issuance failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    getConsumerJwks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The public verification keys. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsumerJwks"];
                };
            };
            /** @description Publication failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    getAdminMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The authenticated administrator. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminMe"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    listAdminUsers: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number | null;
                /** @description Case-insensitive literal email substring. */
                email?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The matching administrative Users and their total. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserList"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    getAdminUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The matching administrative User. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
    bootstrapAdmin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminBootstrapRequest"];
            };
        };
        responses: {
            /** @description The first administrator was created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminBootstrapResult"];
                };
            };
            /** @description Bootstrap failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["ProblemDetails"];
                };
            };
        };
    };
}
