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
    "/v1/account-details": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the current User account details
         * @description Returns only the current User’s optional Account Details through the live service session.
         */
        get: operations["getAccountDetails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Partially update the current User account details
         * @description Atomically updates only explicitly allowed Account Details for the current User.
         */
        patch: operations["updateAccountDetails"];
        trace?: never;
    };
    "/v1/account-photo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload the current User photo
         * @description Streams a JPEG, PNG, or WebP body of at most 2 MiB, 8192 pixels per axis, and 40 megapixels to private object storage. The service validates its bounded container structure and stores only an opaque service-route reference in Identity.
         */
        post: operations["uploadAccountPhoto"];
        /**
         * Remove the current User photo
         * @description Clears the current User photo reference and queues private-object cleanup durably.
         */
        delete: operations["deleteAccountPhoto"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/account-photo/{photoId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the current User photo
         * @description Streams the referenced private photo only when the live session owns the User and photo reference.
         */
        get: operations["getAccountPhoto"];
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
         * @description Completes either ordinary email verification or an administrative Reader email-change workflow. For email change, the new address is promoted to canonical and verified, all Reader sessions are revoked, and earlier verification, recovery and email-change workflows are invalidated atomically. Clients extract the `token` query parameter from the action URL and submit it here. Invalid or expired actions return the stable `verification-invalid` Problem Details code without revealing token material.
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
    "/v1/auth/check-password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Check a password-reset action
         * @description Checks whether a password-reset token is current without consuming or mutating it. Unknown, expired, and already consumed actions return `valid: false`. Responses never include token material and are never cached.
         */
        post: operations["checkPasswordReset"];
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
    "/v1/auth/reader-state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue or refresh presentation-only Reader State
         * @description Issues or refreshes short-lived signed Reader State from the live HttpOnly cookie session. The request carries no user, claims, issuer or audience. Reader State holds the opaque subject, stable issuer, Reader-State-specific audience, integer issued/expiry bounds and an empty entitlements list. Expiry never exceeds the live session expiry and is at most 15 minutes. Reader State is for presentation only and never authenticates or authorizes an endpoint. All responses are private, no-store.
         */
        post: operations["issueReaderState"];
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
         * Publish Reader State verification keys
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
    "/v1/auth/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Publish effective authentication capabilities and password policy
         * @description Returns deployment-owned authentication capabilities and password creation policy. No secrets or provider configuration are included; the response is never cached.
         */
        get: operations["getAuthConfig"];
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
    "/v1/admin/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Establish an Administrator session */
        post: operations["loginAdministrator"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/sign-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Invalidate the current Administrator session */
        post: operations["signOutAdministrator"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/verify-email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete Administrator email verification */
        post: operations["verifyAdministratorEmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/request-verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request Administrator email verification */
        post: operations["requestAdministratorVerification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/request-password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request Administrator password recovery */
        post: operations["requestAdministratorPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/check-password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check an Administrator password-reset action */
        post: operations["checkAdministratorPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/auth/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete Administrator password reset */
        post: operations["resetAdministratorPassword"];
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
    "/v1/admin/administrators": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Administrators
         * @description Returns safe application-owned Administrator metadata and access state in ascending email order.
         */
        get: operations["listAdminAdministrators"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/administrators/{administratorId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one Administrator */
        get: operations["getAdminAdministrator"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/administrators/{administratorId}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Administrator lifecycle activity */
        get: operations["getAdminAdministratorActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/administrators/{administratorId}/access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set Administrator access
         * @description Atomically disables or rehabilitates another Administrator using a strong revision precondition.
         */
        put: operations["setAdminAdministratorAccess"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/administrators/{administratorId}/email-verification/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule an Administrator verification message
         * @description Schedules verification for another Administrator, including a disabled account, without changing access or exposing a token, action URL or delivery result.
         */
        post: operations["requestAdminAdministratorEmailVerificationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/administrators/{administratorId}/password-recovery/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule an Administrator password recovery message
         * @description Schedules normal password recovery for another Administrator with a usable credential, including a disabled account, without changing access or exposing secrets.
         */
        post: operations["requestAdminAdministratorPasswordRecoveryMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/audit-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read global Administrative Audit
         * @description Returns allowlisted authenticated Administrator commands newest-first from the Event Ledger. It is distinct from Reader Account Activity and never returns personal or secret data.
         */
        get: operations["listAdminAuditEvents"];
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
    "/v1/admin/users/{userId}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Reader lifecycle activity
         * @description Returns only allowlisted successful lifecycle events in newest-first order. Existing history is not backfilled, routine login/logout is excluded, and cursors are opaque.
         */
        get: operations["getAdminReaderActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Disable or rehabilitate Reader access
         * @description Changes the Reader access state with its account revision precondition. Disabling revokes all Reader sessions; rehabilitation permits future sign-in but never restores revoked sessions. An active deletion request blocks this independent access transition.
         */
        put: operations["updateAdminReaderAccess"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/email-verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Force the canonical Reader email verified
         * @description Marks only the current canonical Reader email verified and invalidates pending verification actions. It never sends mail or revokes Reader sessions.
         */
        put: operations["forceAdminReaderEmailVerification"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/email-verification/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule a Reader verification message
         * @description Schedules a new verification message for an unverified Reader email without exposing a token, action URL or delivery result.
         */
        post: operations["requestAdminReaderEmailVerificationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/password-recovery/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule a Reader password recovery message
         * @description Schedules normal password recovery only for a Reader with a usable credential method. The Administrator never receives or sets the password.
         */
        post: operations["requestAdminReaderPasswordRecoveryMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/email-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create or replace a pending Reader email change
         * @description Reserves a normalized email for an active Reader and schedules verification to the new address plus a notice to the current address. The canonical email remains unchanged until the public verification action completes.
         */
        post: operations["startAdminReaderEmailChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/email-changes/{emailChangeId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resend a pending Reader email-change message
         * @description Rotates the verification token and schedules the verification and current-address notice for a pending Reader email-change workflow.
         */
        post: operations["resendAdminReaderEmailChangeMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/email-changes/{emailChangeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Cancel a pending Reader email change
         * @description Cancels a pending email-change workflow with its workflow revision precondition and releases the email reservation.
         */
        delete: operations["cancelAdminReaderEmailChange"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/deletion-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a Reader deletion request for review
         * @description Snapshots the Reader access state, immediately suspends effective access, revokes Reader sessions and atomically records the request, Event Ledger lifecycle event, audit event and idempotency result. The optional note is stored only on the request, never in ledger metadata. No email is sent.
         */
        post: operations["createAdminReaderDeletionRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/deletion-requests/{requestId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Review or cancel a Reader deletion request
         * @description Transitions pending_review to approved, rejected or cancelled, and permits approved to be cancelled while no material deletion exists. Rejecting or cancelling restores the exact snapshotted access state. Approval/rejection require an administrative note; notes are stored only on the request and never copied to the Event Ledger.
         */
        put: operations["transitionAdminReaderDeletionRequest"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{userId}/account-details": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read one User’s Account Details for administrators
         * @description Returns only the selected User’s optional Account Details to an authorized Administrator. Anonymous or invalid sessions receive 401; non-administrators receive 403 before target existence is disclosed; authorized missing Users receive 404.
         */
        get: operations["getAdminUserAccountDetails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update one User’s Account Details for administrators
         * @description Atomically updates only allowlisted Account Details for the selected User. Unknown or Identity-owned fields reject the entire request.
         */
        patch: operations["updateAdminUserAccountDetails"];
        trace?: never;
    };
    "/v1/admin/auth/bootstrap": {
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
         * @description Creates the first administrative User through the auth engine after migrations, using explicit operator-supplied credentials. Succeeds only while no administrator exists; repeats and conflicting identities fail with stable machine codes instead of duplicating privileged accounts. The bootstrapped administrator remains subject to the deployment email verification policy before signing in. Creation schedules its first verification message; delivery failure does not undo the administrator. A concurrent active bootstrap may return a retryable 409 while its lease is still held.
         */
        post: operations["bootstrapAdministrator"];
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
         * Bootstrap the first administrator (deprecated path)
         * @description Deprecated compatibility alias for POST /v1/admin/auth/bootstrap. The request, authorization, first-Administrator claim and storage all belong exclusively to the Administrator realm.
         */
        post: operations["bootstrapAdmin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v2/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register an email identity without a public name
         * @description Creates an unverified email/password identity from email and password only. The full email address is used as Better Auth’s required technical name; Account Details remain unset until explicitly provided through their own operations.
         */
        post: operations["registerIdentityV2"];
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
        AccountDetails: {
            firstName: string | null;
            lastName: string | null;
            birthDate: string | null;
            phone: string | null;
            image: string | null;
        };
        IdentityProblemDetails: {
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
            /**
             * @example [
             *       "min-uppercase"
             *     ]
             */
            failedRules?: ("min-length" | "max-length" | "min-uppercase" | "min-lowercase" | "min-digits" | "min-symbols")[];
            passwordPolicy?: {
                minLength: number;
                maxLength: number;
                minUppercase: number;
                minLowercase: number;
                minDigits: number;
                minSymbols: number;
            };
        };
        UpdateAccountDetails: {
            firstName?: string | null;
            lastName?: string | null;
            birthDate?: string | null;
            phone?: string | null;
            image?: "" | string | null;
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
            name?: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example Correct-horse-41 */
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
            /** @example Correct-horse-41 */
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
        CheckPasswordResetResult: {
            /** @example true */
            valid: boolean;
        };
        CheckPasswordResetRequest: {
            /** @description Password-reset token from the action URL. */
            token: string;
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
            /** @example Correct-horse-41 */
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
            /**
             * @example reader
             * @enum {string}
             */
            realm: "reader";
        };
        SignOutResult: {
            /**
             * @example ok
             * @enum {string}
             */
            status: "ok";
        };
        ReaderState: {
            /**
             * @description Short-lived signed presentation-only Reader State.
             * @example eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhYmMxMjMifQ.sig
             */
            readerState: string;
            /**
             * @description Reader State expiry as integer Unix seconds.
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
        AuthConfig: {
            capabilities: components["schemas"]["AuthCapabilities"];
            passwordPolicy: components["schemas"]["PasswordPolicy"];
        };
        AuthCapabilities: {
            registration: boolean;
            emailPassword: boolean;
            emailVerification: boolean;
            passwordReset: boolean;
        };
        PasswordPolicy: {
            /** @example 8 */
            minLength: number;
            /** @example 128 */
            maxLength: number;
            /** @example 1 */
            minUppercase: number;
            /** @example 1 */
            minLowercase: number;
            /** @example 1 */
            minDigits: number;
            /** @example 0 */
            minSymbols: number;
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
            /**
             * @example administrator
             * @enum {string}
             */
            realm: "administrator";
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
            /**
             * @example reader
             * @enum {string}
             */
            realm: "reader";
            /** @example user */
            role: string;
        };
        AdminAdministratorList: {
            /** @description Ascending email order. */
            items: components["schemas"]["AdminAdministrator"][];
            /** @description Matches before pagination. */
            total: number;
        };
        AdminAdministrator: components["schemas"]["AdminMe"] & {
            /** @example 1 */
            revision: number;
            access: components["schemas"]["AdminAdministratorAccess"];
        };
        AdminAdministratorAccess: {
            /** @enum {string} */
            state: "active" | "disabled";
        };
        AdminAdministratorDetail: components["schemas"]["AdminAdministrator"] & {
            summary: {
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
            };
            methods: {
                /** @enum {string} */
                type: "password" | "social";
                /** @enum {string} */
                provider?: "google" | "facebook" | "apple";
            }[];
        };
        AdminAdministratorActivity: {
            items: {
                id: string;
                /** @enum {string} */
                type: "email-verified" | "email-verification-requested" | "password-recovery-requested" | "sessions-revoked" | "access-disabled" | "access-rehabilitated";
                /** Format: date-time */
                occurredAt: string;
                actor: {
                    id: string;
                    /** @enum {string} */
                    realm: "administrator";
                };
            }[];
            nextCursor: string | null;
        };
        AdminAdministratorAccessResult: {
            /** @enum {string} */
            state: "active" | "disabled";
            changed: boolean;
            revision: number;
        };
        AdminAdministratorAccessRequest: {
            /** @enum {string} */
            state: "active" | "disabled";
        };
        AdminAdministratorMessage: {
            workflowId: string;
            /** @enum {string} */
            kind: "email-verification" | "password-recovery";
            /** @enum {string} */
            state: "scheduled";
            /** Format: date-time */
            cooldownUntil: string;
            revision: number;
        };
        AdminAdministratorMessageRequest: Record<string, never>;
        AdminAuditEvents: {
            items: components["schemas"]["AdminAuditEvent"][];
            nextCursor: string | null;
        };
        AdminAuditEvent: {
            id: string;
            version: number;
            type: string;
            /** Format: date-time */
            occurredAt: string;
            actor: {
                id: string;
                /** @enum {string} */
                realm: "administrator";
            };
            subject: {
                id: string;
                /** @enum {string} */
                realm: "reader" | "administrator";
            } | null;
            /** @enum {string} */
            result: "success" | "failure";
            requestId: string;
            problemCode: components["schemas"]["AdminAuditProblemCode"];
            metadata: components["schemas"]["AdminAuditMetadata"];
        };
        /** @enum {string|null} */
        AdminAuditProblemCode: "bad-request" | "conflict" | "payload-too-large" | "service-unavailable" | "not-found" | "internal-error" | "registration-disabled" | "email-password-disabled" | "email-verification-required" | "invalid-credentials" | "verification-invalid" | "reset-invalid" | "unauthenticated" | "forbidden" | "reader-not-found" | "administrator-not-found" | "administrator-disabled" | "self-disable-forbidden" | "last-operational-administrator" | "invalid-transition" | "no-usable-login-method" | "idempotency-key-reused" | "stale-revision" | "precondition-required" | "cooldown-active" | "delivery-scheduling-failed" | "admin-already-bootstrapped" | "admin-bootstrap-in-progress" | "admin-email-conflict" | "same-email" | "email-conflict" | "email-change-not-found" | "active-deletion-request" | "deletion-request-not-found" | null;
        AdminAuditMetadata: {
            changed?: boolean;
            operation?: string;
            revision?: number;
            /** @enum {string} */
            previousAccessState?: "active" | "disabled";
            retryAfterSeconds?: number;
            /** @enum {string} */
            state?: "committed" | "scheduling-failed" | "pending_review" | "approved" | "rejected" | "cancelled";
            supersedesId?: string;
            workflowId?: string;
        } | null;
        AdminReaderDetail: components["schemas"]["AdminUser"] & {
            /** @example 1 */
            revision: number;
            summary: components["schemas"]["AdminReaderSummary"];
            access: components["schemas"]["AdminReaderAccess"];
            /** @enum {string|null} */
            deletionState: "pending_review" | "approved" | null;
            /** @description Safe locally usable login methods without provider identifiers. */
            methods: {
                /** @enum {string} */
                type: "password" | "social";
                /** @enum {string} */
                provider?: "google" | "facebook" | "apple";
            }[];
            /** @description Only persisted active workflows; never inferred or fabricated. */
            activeWorkflows: ({
                id: string;
                /** @enum {string} */
                type: "email-verification-message";
                state: string;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                cooldownUntil: string;
            } | {
                id: string;
                /** @enum {string} */
                type: "password-recovery-message";
                state: string;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                cooldownUntil: string;
            } | {
                id: string;
                /** @enum {string} */
                type: "deletion-request";
                /** @enum {string} */
                state: "pending_review" | "approved";
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                cooldownUntil?: string;
                revision: number;
                /** @enum {string} */
                previousAccessState: "active" | "disabled";
            } | {
                id: string;
                /** @enum {string} */
                type: "email-change";
                /** @enum {string} */
                state: "pending";
                /** Format: date-time */
                createdAt: string;
                /**
                 * Format: email
                 * @example ada@example.com
                 */
                email: string;
                /** Format: date-time */
                expiresAt: string;
                /** Format: date-time */
                cooldownUntil: string;
                revision: number;
            })[];
        };
        AdminReaderSummary: {
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminReaderAccess: {
            /** @enum {string} */
            state: "active" | "disabled";
            /** @enum {string} */
            effectiveState: "active" | "disabled" | "suspended";
        };
        AdminReaderActivity: {
            items: components["schemas"]["AdminReaderActivityEvent"][];
            nextCursor: string | null;
        };
        AdminReaderActivityEvent: {
            id: string;
            /** @enum {string} */
            type: "email-verified" | "email-verification-requested" | "password-recovery-requested" | "email-change-requested" | "email-change-cancelled" | "email-changed" | "social-identity-unlinked" | "sessions-revoked" | "access-disabled" | "access-rehabilitated" | "deletion-requested" | "deletion-approved" | "deletion-rejected" | "deletion-cancelled";
            /** Format: date-time */
            occurredAt: string;
            actor: {
                id: string;
                /** @enum {string} */
                realm: "administrator";
            };
        };
        AdminReaderAccessResult: {
            /** @enum {string} */
            state: "active" | "disabled";
            changed: boolean;
            revision: number;
        };
        AdminReaderAccessRequest: {
            /** @enum {string} */
            state: "active" | "disabled";
        };
        AdminReaderEmailVerification: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            emailVerified: boolean;
            changed: boolean;
            revision: number;
        };
        AdminReaderMessage: {
            workflowId: string;
            /** @enum {string} */
            kind: "email-verification" | "password-recovery";
            /** @enum {string} */
            state: "scheduled";
            /** Format: date-time */
            cooldownUntil: string;
            revision: number;
        };
        AdminReaderMessageRequest: Record<string, never>;
        AdminReaderEmailChange: {
            workflowId: string;
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @enum {string} */
            state: "pending";
            changed: boolean;
            revision: number;
            accountRevision: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            cooldownUntil: string;
        };
        AdminReaderEmailChangeRequest: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
        };
        AdminReaderEmailChangeMessage: {
            workflowId: string;
            /** @enum {string} */
            state: "pending";
            /** Format: date-time */
            cooldownUntil: string;
            /** Format: date-time */
            expiresAt: string;
            revision: number;
        };
        AdminReaderEmailChangeCommand: Record<string, never>;
        AdminReaderEmailChangeCancel: {
            workflowId: string;
            /** @enum {string} */
            state: "pending" | "cancelled" | "completed" | "superseded" | "expired";
            changed: boolean;
            revision: number;
        };
        AdminReaderDeletionRequest: {
            requestId: string;
            /** @enum {string} */
            state: "pending_review";
            /** @enum {string} */
            previousAccessState: "active" | "disabled";
            /** @enum {boolean} */
            changed: true;
            revision: number;
            accountRevision: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminReaderDeletionRequestCreate: {
            note?: string;
        };
        AdminReaderDeletionRequestTransition: {
            requestId: string;
            /** @enum {string} */
            state: "pending_review" | "approved" | "rejected" | "cancelled";
            /** @enum {string} */
            previousAccessState: "active" | "disabled";
            changed: boolean;
            revision: number;
            accountRevision: number;
            /** Format: date-time */
            updatedAt: string;
        };
        AdminReaderDeletionRequestStatus: {
            /** @enum {string} */
            state: "pending_review";
            /** @description Optional note, trimmed and limited to 2,000 characters by the service. */
            note?: string;
        } | {
            /** @enum {string} */
            state: "approved";
            /** @description Required for approval, trimmed and limited to 2,000 characters by the service. */
            note: string;
        } | {
            /** @enum {string} */
            state: "rejected";
            /** @description Required for rejection, trimmed and limited to 2,000 characters by the service. */
            note: string;
        } | {
            /** @enum {string} */
            state: "cancelled";
            /** @description Optional note, trimmed and limited to 2,000 characters by the service. */
            note?: string;
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
             * @example administrator
             * @enum {string}
             */
            realm: "administrator";
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
            /** @example Correct-horse-41 */
            password: string;
        };
        RegisterWithoutNameRequest: {
            /**
             * Format: email
             * @example ada@example.com
             */
            email: string;
            /** @example Correct-horse-41 */
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
    getAccountDetails: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current User’s Account Details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountDetails"];
                };
            };
            /** @description Authentication failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    updateAccountDetails: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["UpdateAccountDetails"];
            };
        };
        responses: {
            /** @description The Account Details update was committed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation or authentication failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    uploadAccountPhoto: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "image/jpeg": string;
                "image/png": string;
                "image/webp": string;
            };
        };
        responses: {
            /** @description The photo reference was saved for the current User. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation, authentication, storage or configuration failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    deleteAccountPhoto: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current User photo reference was cleared. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication or storage failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAccountPhoto: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                photoId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The private photo bytes, streamed with its validated media type. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": string;
                    "image/png": string;
                    "image/webp": string;
                };
            };
            /** @description Authentication, ownership, object availability or storage failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
            /** @description Ordinary verification completed, or email change atomically promoted and verified the new canonical address while revoking sessions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerifyEmailResult"];
                };
            };
            /** @description Invalid or expired action; stable code `verification-invalid`. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description An active Reader deletion request blocks email-change completion; stable code `active-deletion-request`. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Atomic completion failed; no partial email-change effects are committed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Verification failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    checkPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CheckPasswordResetRequest"];
            };
        };
        responses: {
            /** @description Whether the password-reset action is current. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CheckPasswordResetResult"];
                };
            };
            /** @description Check failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    issueReaderState: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The signed Reader State and its integer Unix expiry. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReaderState"];
                };
            };
            /** @description Issuance failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAuthConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The effective public authentication configuration. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthConfig"];
                };
            };
            /** @description Configuration failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    loginAdministrator: {
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
            /** @description Authenticated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResult"];
                };
            };
            /** @description Administrator authentication failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    signOutAdministrator: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed out. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignOutResult"];
                };
            };
            /** @description Administrator sign-out failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    verifyAdministratorEmail: {
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
            /** @description Verified. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerifyEmailResult"];
                };
            };
            /** @description Verification failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdministratorVerification: {
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
            /** @description Accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RequestVerificationResult"];
                };
            };
            /** @description Verification request failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdministratorPasswordReset: {
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
            /** @description Accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RequestPasswordResetResult"];
                };
            };
            /** @description Password reset request failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    checkAdministratorPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CheckPasswordResetRequest"];
            };
        };
        responses: {
            /** @description Token status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CheckPasswordResetResult"];
                };
            };
            /** @description Password reset check failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    resetAdministratorPassword: {
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
            /** @description Password reset. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResetPasswordResult"];
                };
            };
            /** @description Password reset failure. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    listAdminAdministrators: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number | null;
                email?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The matching Administrators and their total. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorList"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAdminAdministrator: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                administratorId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The matching Administrator detail. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorDetail"];
                };
            };
            /** @description Authorization or lookup failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAdminAdministratorActivity: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                administratorId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The Administrator lifecycle activity page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorActivity"];
                };
            };
            /** @description Authorization, lookup, or cursor failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    setAdminAdministratorAccess: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
            };
            path: {
                administratorId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminAdministratorAccessRequest"];
            };
        };
        responses: {
            /** @description The committed Administrator access state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorAccessResult"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Reader state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The resource revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdminAdministratorEmailVerificationMessage: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                administratorId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminAdministratorMessageRequest"];
            };
        };
        responses: {
            /** @description The verification message was accepted for scheduling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorMessage"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Administrator not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Administrator state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required Idempotency-Key is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdminAdministratorPasswordRecoveryMessage: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                administratorId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminAdministratorMessageRequest"];
            };
        };
        responses: {
            /** @description The recovery message was accepted for scheduling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAdministratorMessage"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Administrator not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Administrator state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required Idempotency-Key is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    listAdminAuditEvents: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @description Filter by opaque Administrator actor ID. */
                actorId?: string;
                /** @description Filter by versioned Event Ledger type. */
                action?: string;
                result?: "success" | "failure";
                /** @description Inclusive lower bound for event occurrence time. */
                from?: string;
                /** @description Inclusive upper bound for event occurrence time. */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The filtered Administrative Audit page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminAuditEvents"];
                };
            };
            /** @description Invalid filters or cursor. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is disabled or lacks Administrator authority. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The audit projection could not be completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
                    "application/json": components["schemas"]["AdminReaderDetail"];
                };
            };
            /** @description Authorization failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAdminReaderActivity: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The Reader lifecycle activity page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderActivity"];
                };
            };
            /** @description Invalid parameters or cursor. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor lacks authority or is disabled. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Internal failure. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    updateAdminReaderAccess: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderAccessRequest"];
            };
        };
        responses: {
            /** @description The current or changed Reader access state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderAccessResult"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Reader state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The resource revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    forceAdminReaderEmailVerification: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current canonical email verification state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderEmailVerification"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Reader state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The resource revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdminReaderEmailVerificationMessage: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderMessageRequest"];
            };
        };
        responses: {
            /** @description The verification message was accepted for scheduling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderMessage"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Reader state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The resource revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    requestAdminReaderPasswordRecoveryMessage: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderMessageRequest"];
            };
        };
        responses: {
            /** @description The recovery message was accepted for scheduling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderMessage"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with current Reader state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The resource revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the command was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    startAdminReaderEmailChange: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
                "idempotency-key"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderEmailChangeRequest"];
            };
        };
        responses: {
            /** @description An existing pending email-change workflow was replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderEmailChange"];
                };
            };
            /** @description A new email-change workflow was created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderEmailChange"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session or invalid verification token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader or email-change workflow not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with the canonical email or workflow state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The supplied revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition or idempotency key is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The email-change message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the workflow was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    resendAdminReaderEmailChangeMessage: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                userId: string;
                emailChangeId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderEmailChangeCommand"];
            };
        };
        responses: {
            /** @description The email-change messages were accepted for scheduling. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderEmailChangeMessage"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session or invalid verification token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader or email-change workflow not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with the canonical email or workflow state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The supplied revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition or idempotency key is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The email-change message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the workflow was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    cancelAdminReaderEmailChange: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
                "idempotency-key"?: string;
            };
            path: {
                userId: string;
                emailChangeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current or newly cancelled workflow state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderEmailChangeCancel"];
                };
            };
            /** @description Invalid command input. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session or invalid verification token. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not allowed to perform the command. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader or email-change workflow not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command conflicts with the canonical email or workflow state. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The supplied revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required precondition or idempotency key is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The email-change message cooldown is active. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Message scheduling failed after the workflow was committed. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    createAdminReaderDeletionRequest: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
                "idempotency-key"?: string;
            };
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderDeletionRequestCreate"];
            };
        };
        responses: {
            /** @description A pending review request was created and effective access suspended. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderDeletionRequest"];
                };
            };
            /** @description Invalid request or note. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not authorized or is disabled. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader or deletion request not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description An active request exists or the requested state transition is invalid. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The supplied account or workflow revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required If-Match or Idempotency-Key header is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    transitionAdminReaderDeletionRequest: {
        parameters: {
            query?: never;
            header?: {
                "if-match"?: string;
                "idempotency-key"?: string;
            };
            path: {
                userId: string;
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["AdminReaderDeletionRequestStatus"];
            };
        };
        responses: {
            /** @description The deletion request transitioned or the current same-state result was replayed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminReaderDeletionRequestTransition"];
                };
            };
            /** @description Invalid request or note. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description No authoritative Administrator session. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The actor is not authorized or is disabled. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description Reader or deletion request not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description An active request exists or the requested state transition is invalid. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The supplied account or workflow revision is stale. */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description A required If-Match or Idempotency-Key header is missing. */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
            /** @description The command could not be audited or completed. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    getAdminUserAccountDetails: {
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
            /** @description The selected User’s Account Details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountDetails"];
                };
            };
            /** @description Authorization or lookup failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    updateAdminUserAccountDetails: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Opaque administrative User identifier. */
                userId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["UpdateAccountDetails"];
            };
        };
        responses: {
            /** @description The selected User’s updated Account Details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountDetails"];
                };
            };
            /** @description Validation, authorization or lookup failure as RFC 9457 Problem Details. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    bootstrapAdministrator: {
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
            /** @description The first administrator was created and verification was requested. */
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
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
            /** @description The first Administrator was created and verification was requested. */
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
    registerIdentityV2: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RegisterWithoutNameRequest"];
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
                    "application/problem+json": components["schemas"]["IdentityProblemDetails"];
                };
            };
        };
    };
}
