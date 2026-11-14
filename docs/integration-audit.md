# Integration audit — November 14, 2026

Reviewed against Stalwart **v1.1.0**
(`e7cde9b3fac32d2a254ef782efec56f2373ec5d4`) and Keycloak **26.8.2**.
These were the latest published releases when checked.

| Contract | Result |
| --- | --- |
| JMAP session and account selection | Fixed in 0.1.3. `urn:stalwart:jmap` is advertised in the personal account's `accountCapabilities` and in `primaryAccounts`, without a top-level session capability. Account binding and same-origin API validation remain enforced. |
| App-password API | `x:AppPassword/set`, `create.device.description`, tagged `CredentialPermissions.Replace`, and `created.device.id` / `secret` match Stalwart. Tested against the real server, including the stored permission map. |
| OAuth scope enforcement | Source review confirms that security permits credential management and mail/calendars permit granting the requested protocol permissions. Settings and full are unnecessary for the app's requests. Recognized first-party clients can be unrestricted; a scope request alone does not prove the token's granted scopes or audience. |
| Application hosting and CIMD | The manifest, relative client template, rendered client ID, public-client authentication method, redirect URI, prefix rewrite, and optional injected scope meta tag match the application manager. Real hosting tested at two prefixes. |
| Keycloak sign-in contract | Reviewed CIMD registration, authorization-code/PKCE, discovery, scope assignment, resource-indicator enforcement, and audience mapper behavior. The app sends the same resource in authorization and token requests. The installation must allow the requested scopes and resource. |
| PACC and profile payload | Hostnames, SMTP naming, TLS ports, CalDAV URL, and password-authentication advertisement match Stalwart's response. Profiles generated from that response compare equal to the Python generator, including UUIDs and embedded credentials. |
| Credential lifecycle | Signing in creates no password. Generation and repeated downloads create one per workflow. Real credential authentication succeeds over IMAP, SMTP, and CalDAV; creating another credential with that password is forbidden. Lost-response handling and duplicate prevention also have fixture-based failure tests. |
| Release metadata | The manifest, OAuth document, npm package, Python package, and uv lock agree on 0.1.4. The workflow checks all five against the release tag. |

The session capability check was the integration mismatch found in the reviewed
paths. Earlier test fixtures repeated the same incorrect assumption, which
allowed the defect to pass. Unit and browser fixtures now use the account-level
advertisement. The release workflow also runs
[`tests/stalwart_smoke.py`](../tests/stalwart_smoke.py) against the pinned
Stalwart 1.1.0 executable, in addition to the unit and simulated browser checks.

The real-server checks use temporary state, generated test credentials, an
ephemeral test certificate, and allocated local service ports. They exercise
Stalwart's built-in OAuth provider. Keycloak was inspected at the source level;
these checks do not authenticate against the user's Keycloak realm or prove the
audience of an actual Keycloak access token. They also do not install the profile
on macOS or iOS.

Source references:

- Stalwart [session construction and account capabilities](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/jmap/src/api/session.rs)
  and [session capability configuration](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/config/mailstore/capabilities.rs).
- Stalwart [credential creation and validation](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/jmap/src/registry/mapping/account.rs),
  [OAuth permission mapping](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/auth/oauth/scope.rs),
  and [external token validation](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/directory/src/backend/oidc/lookup.rs).
- Stalwart [client template rendering](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/manager/app_client.rs),
  [application manager](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/manager/application.rs),
  and [PACC schema](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/network/autoconfig/pacc.rs).
- Keycloak [CIMD policy executor](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oauth2/cimd/clientpolicy/executor/AbstractClientIdMetadataDocumentExecutor.java),
  [persistent client registration](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oauth2/cimd/provider/AbstractPersistentClientIdMetadataDocumentProvider.java),
  [discovery](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oidc/OIDCWellKnownProvider.java),
  and [resource-indicator processing](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oidc/resourceindicators/ResourceIndicatorsPostProcessor.java).
