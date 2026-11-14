# stalwart-mobileconfig

Set up **Apple Mail and CalDAV** from the configuration served by Stalwart.
The Stalwart-hosted webapp signs the user in with Keycloak, creates a device
app password, and downloads a profile with the settings and credentials filled
in. A Python command-line generator is also available.

## Stalwart-hosted webapp

The frontend is a static application bundle. Stalwart serves it; the browser
handles OAuth, calls JMAP, and writes the profile. There is no separate backend,
client secret, database, or frontend dependency installation.

Build the installable ZIP with Python:

```sh
python3 scripts/build_webapp.py
```

This writes `dist/stalwart-mobileconfig.zip`. Its manifest targets Stalwart
1.1.0 or later with native application hosting, the `x:AppPassword/set`
JMAP extension, and the OAuth security scope for credential management.

Place the ZIP on the Stalwart server, for example at
`/opt/stalwart/stalwart-mobileconfig.zip`, and configure an Application object:

```json
{
  "enable": true,
  "description": "Apple Mail and Calendar setup",
  "resourceUrl": "file:///opt/stalwart/stalwart-mobileconfig.zip",
  "urlPrefix": {"/apple-setup": true}
}
```

Alternatively, set `resourceUrl` to an HTTPS URL from which Stalwart can download
the ZIP. Once a GitHub release has been published, the latest release's bundle
is available at this URL:

```text
https://github.com/NickCao/stalwart-mobileconfig/releases/latest/download/stalwart-mobileconfig.zip
```

Use that URL as `resourceUrl`, or replace `latest/download` with
`download/v0.1.0` to select a specific release.
The application manager's resource URL points to the bundle; users
visit the app served by Stalwart, such as `https://mail.example.com/apple-setup/`.
An installation prefix other than `/apple-setup` works too.

### Keycloak and CIMD

Stalwart must already authenticate this domain with the Keycloak directory.
The app discovers the configured issuer through Stalwart's
`/.well-known/oauth-protected-resource` endpoint and reads that issuer's OpenID
configuration. The hostname used to open the app must be a trusted Stalwart
service hostname associated with the intended directory.

Enable Keycloak's CIMD feature and allow the Stalwart hostname in its trusted
client-domain policy. The app uses
`https://mail.example.com/apple-setup/oauth-client.json` as its client ID.
The ZIP contains a template; Stalwart renders the full client ID and redirect
URI for the actual hostname and prefix. No manually registered client is
needed when Keycloak accepts that document.

The redirect returns to `index.html` inside the installed app. Sign-in uses
Authorization Code with PKCE/S256, state validation, and issuer validation.
The app requests `openid`, `profile`, and `email` when the issuer advertises
them. The latter two scopes let Keycloak include the username, display name,
and email claims that Stalwart may need to resolve the mailbox.

The app also requests these three scopes automatically, with no
`oauthScopes` configuration needed on the Stalwart Application:

- `urn:ietf:params:oauth:scope:mail`
- `urn:ietf:params:oauth:scope:calendars`
- `urn:stalwart:oauth:scope:security`

Security permits app-password creation. Mail and calendars permit assigning
the matching protocol permissions to the new credential. Keycloak must allow
these client scopes for the CIMD client and include the granted names in the
access token's `scope` claim. Advertising them in discovery alone does not
grant them. The app requests all three even when they are not advertised,
because each is required for setup. It does not request the broader `full`
scope or the unrelated `settings` scope.

The requested resource is the Stalwart origin. Stalwart must accept the
Keycloak access token's issuer and audience, as for its other first-party clients.
With Keycloak's Resource Indicators feature enabled, add that origin to the
**Resource indicator allow list** of its `client-id-metadata-document` executor.
Otherwise, configure an audience mapper
to include the Stalwart resource identifier or an audience explicitly accepted
by Stalwart's OIDC directory.

If an optional Keycloak client scope supplies that mapper or other required
claims, add it to this Stalwart Application's `oauthScopes`. For example, for
a client scope named `stalwart` that you have already configured in Keycloak:

```json
{
  "oauthScopes": {"stalwart": true}
}
```

Stalwart injects these extra scopes into the app's `oauth-scopes` meta tag;
the app includes them alongside its built-in setup and identity scopes at sign-in.
The Keycloak token endpoint must permit browser requests from the Stalwart
origin; enabling CIMD alone does not replace the realm's trust and CORS policy.

If `/jmap/session` returns 401 immediately after a successful Keycloak sign-in,
Stalwart rejected the newly issued access token. Check Stalwart's authentication
log for the validation reason: a missing username claim, an unacceptable
audience, an issuer/signature error, or an unrecognized client can all prevent
authentication. Requesting `resource` does not by itself enable Keycloak's
Resource Indicators feature or configure an audience mapper. Keep audience
validation enabled, and avoid posting access tokens in bug reports.

If sign-in instead succeeds but the page says **App-password setup is
unavailable for this sign-in**, check whether Keycloak issued the security
scope. Stalwart filters `urn:stalwart:jmap` out of scope-limited JMAP sessions,
so a missing capability does not necessarily mean the server lacks the API.
Also check the granted mail and calendar scopes if credential creation is
forbidden. After changing scope configuration, sign in again for a new token.

### What the user does

1. Open the app and sign in with their normal Keycloak account. An existing
   Keycloak SSO session can be reused.
2. Click **Download setup profile**. The account and optional outgoing display
   name come from the authenticated JMAP session. The device name has a default.
3. Install the downloaded file through Apple's profile installation UI.

The app validates the advertised IMAP, SMTP, and CalDAV settings before creating
a credential. Settings come from Stalwart's same-origin
`/.well-known/user-agent-configuration.json`, so discovery does not need an
extra cross-origin request. Profile identifiers and UUIDs match the Python
generator for ordinary mailbox addresses, including IDN domains.

Each setup creates one labeled app password with explicit permissions for
IMAP, SMTP submission, and CalDAV. It does not inherit account-administration
permissions. The account must be allowed to grant those protocol permissions.
No password is created merely by opening the page or signing in.

The 55 permissions in [`DEVICE_PERMISSIONS`](web/api.js) were audited on
November 14, 2026 against Stalwart **v1.1.0**, commit
`e7cde9b3fac32d2a254ef782efec56f2373ec5d4` (also the current `main`).
All names are valid in v1.0.0 as well; no additions or renames were needed.

| Group | Requested permissions | Count |
| --- | --- | ---: |
| Authentication | `authenticate` | 1 |
| SMTP submission | `emailSend` | 1 |
| Calendar scheduling | `calendarSchedulingSend`, `calendarSchedulingReceive` | 2 |
| IMAP | All `imap*` permissions | 31 |
| CalDAV | All `davCal*` permissions | 13 |
| Shared DAV reports and principal discovery | `davSyncCollection`, `davExpandProperty`, `davPrincipalAcl`, `davPrincipalList`, `davPrincipalMatch`, `davPrincipalSearch`, `davPrincipalSearchPropSet` | 7 |

The request uses `CredentialPermissions.Replace`; Stalwart intersects the
credential's permissions with the account's effective permissions. The list
includes mailbox and calendar sharing changes (`imapAclSet`, `davCalAcl`).
`davPrincipalAcl` permits the read-only `acl-principal-prop-set` report.

Contact-specific (`davCard*`) and file-specific (`davFile*`) permissions are
omitted. However, Stalwart dispatches `davSyncCollection` and
`davExpandProperty` reports across calendar, contact, and file collections.
This list therefore should not be treated as a hard calendar-only DAV boundary.
That conclusion comes from source inspection, without a live cross-service
access test. The list aims for protocol compatibility rather than the minimum
possible set: for example, `calendarSchedulingReceive` is valid, but inbound
invitation processing checks it on the recipient account rather than the
device credential.

The audit checked the upstream
[permission parser](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/registry/src/schema/enums_impl.rs),
[credential permission enforcement](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/common/src/auth/access_token.rs),
and IMAP, SMTP, calendar scheduling, and
[DAV request handlers](https://github.com/stalwartlabs/stalwart/blob/e7cde9b3fac32d2a254ef782efec56f2373ec5d4/crates/dav/src/request.rs).

**Download again** reuses the same file and password while the tab stays open.
If the creation response is lost, the app blocks another creation attempt
and asks the user to check their app passwords in Stalwart first.

Access tokens and generated files stay in memory. Only the short-lived PKCE
transaction is stored in `sessionStorage`, and it is removed on callback.
Refreshing or leaving the page discards the in-memory download; a later setup
creates a new password. Signing out of the setup page clears its state, while
the Keycloak SSO session can remain active. Device passwords can be revoked in
Stalwart's Account > Credentials > App Passwords.

The profile is unsigned and contains the app password as plain XML. Use HTTPS,
keep the downloaded file private, and delete it after installation.

## Command-line generator

Python's `plistlib` writes the XML. The CLI has no runtime dependencies outside
the standard library.

```sh
uv run stalwart-mobileconfig nickcao@nichi.co -o nickcao.mobileconfig
```

The email address determines the discovery URL:

```text
https://ua-auto-config.nichi.co/.well-known/user-agent-configuration.json
```

The generator uses the advertised IMAP host, SMTP host, CalDAV URL and provider
name. IMAP uses implicit TLS on port 993 and SMTP uses implicit TLS on port 465,
as defined by PACC. The full email address is the username for both mail and
calendar accounts. The CalDAV URL, including its path, is placed in Apple's
`CalDAVPrincipalURL` field. Other advertised services are ignored.

Optionally supply a display name for outgoing mail:

```sh
uv run stalwart-mobileconfig nickcao@nichi.co --name 'Nick Cao' > nickcao.mobileconfig
```

Optionally embed a password for IMAP, SMTP and CalDAV:

```sh
uv run stalwart-mobileconfig nickcao@nichi.co --password 'your-app-password' -o nickcao.mobileconfig
```

The password is stored as plain text in the generated XML. It can also appear in
your shell history and process arguments when supplied this way. Omitting
`--password` keeps passwords out of the profile.

## Installing the profile

Open the file on your Mac, iPhone or iPad and install it through the profile
installation UI. It is unsigned. If `--password` was omitted, Apple prompts for
the password during manual installation; Mail reuses its incoming password for
SMTP, and Calendar may prompt separately. No server addresses or usernames need
to be entered on the device.

When using the CLI with a Keycloak-backed account, create an app password in
Stalwart under Account > Credentials > App Passwords. Supply it with
`--password` or enter it when the device prompts. The generated Apple accounts
use app-password authentication; OAuth/CIMD is used by the webapp to create
the credential, rather than by the installed Mail and Calendar accounts.

Profile identifiers and UUIDs are stable for each email address, so regenerating
a profile retains its identity. The generator requires IMAP, SMTP and CalDAV
endpoints, and refuses a provider that advertises `password: false`.

Discovery uses HTTPS with certificate verification and refuses redirects to
HTTP. It reads Stalwart's PACC document directly; it does not implement PACC's
DNS TXT digest verification or protocol-authentication probing.

## Updating an installed profile

An installed profile is a snapshot; it does not periodically fetch the discovery
document. After changing the advertised server settings, run the generator again
with the same email address and options, then install the new file over the
existing profile. Leave the old profile installed while doing this.

The stable profile and payload identifiers let Apple match the replacement to
the existing Mail and Calendar configuration. The device may ask for passwords
again; credential retention across updates has not been tested on an Apple
device. `PayloadVersion` remains `1`, because it identifies the profile format,
not the revision of your settings.

DNS address changes and normal TLS certificate renewals do not require a new
profile when the configured hostnames and other account settings stay the same.

## Development

Python CLI checks:

```sh
uv sync
uv run python -m unittest discover -s tests -v
uv build
```

Webapp checks require Node.js 22 or later, but no npm dependencies:

```sh
npm test
python3 scripts/build_webapp.py
```

The JavaScript tests exercise OAuth validation, account binding, the app-password
request, download retries, and failure handling. They also compare browser
payloads and UUIDs with the Python generator and parse the generated XML using
`plistlib`. Both unit-test suites run without network access.

Optional browser checks use Python Playwright:

```sh
uv run --no-project --with playwright python -m playwright install --with-deps chromium webkit
uv run --no-project --with playwright python tests/browser_smoke.py
uv run --no-project --with playwright python tests/browser_smoke.py --browser webkit
```

These checks simulate the Stalwart and Keycloak endpoints and download a real
file in the browser. They cover desktop and mobile layouts, different
installation prefixes, repeated downloads, a lost creation response, and expired
sessions in Chromium and WebKit. They also check rejected initial sign-ins and
scope-limited sessions, automatic setup scopes, and extra OAuth scopes
injected by the application manager.
The screenshots are written to `dist/`.

Live Keycloak/Stalwart integration and installation of a browser-generated file
still need to be verified against the actual deployment and on an Apple device.
A downloaded file does not by itself confirm that Apple installed the profile.

## Releases

GitHub Actions runs the Python and JavaScript tests, Chromium and WebKit browser
checks, and the ZIP build on pushes to `master` and pull requests. The built ZIP
is available in the run's `stalwart-mobileconfig` artifact. The workflow can also
be run manually from the Actions tab.

Pushing a version tag such as `v0.1.0` runs the same checks and publishes a GitHub
release with generated release notes and `stalwart-mobileconfig.zip` attached.
Publishing uses GitHub's built-in `GITHUB_TOKEN`; no personal access token or
repository secret is needed.

For a release of the current version:

```sh
git push origin master
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

For later releases, update `version` in `web/stalwart-app.json`, `package.json`,
and `pyproject.toml`, and `software_version` in `web/oauth-client.json`. Commit
those changes, then push the branch and a matching `vMAJOR.MINOR.PATCH` tag.
The workflow refuses to publish if any of those versions differs from the tag.

A rerun can finish an existing draft release. If the release is already
published, it verifies that the attached ZIP matches the new build and leaves
the release intact. Changed bundles require a new version and tag.

## References

- [Stalwart application hosting](https://stalw.art/docs/management/applications/)
- [Stalwart with an external OpenID Connect provider](https://stalw.art/docs/auth/backend/oidc/)
- [Stalwart app-password API](https://stalw.art/docs/ref/object/app-password/)
- [Keycloak CIMD configuration](https://www.keycloak.org/securing-apps/mcp-authz-server)
- [Stalwart autoconfiguration](https://stalw.art/docs/server/autoconfig/)
- [PACC draft](https://datatracker.ietf.org/doc/draft-ietf-mailmaint-pacc/)
- [Python plistlib](https://docs.python.org/3/library/plistlib.html)
- [Apple Mail payload](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.mail.managed.yaml)
- [Apple CalDAV payload](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.caldav.account.yaml)
- [Mailcow's Apple profile setup](https://docs.mailcow.email/client/client-apple/)
