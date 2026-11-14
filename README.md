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
1.0.0 or later with native application hosting and the `x:AppPassword/set`
JMAP extension.

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
the ZIP. The application manager's resource URL points to the bundle; users
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
The requested resource is the Stalwart origin. Stalwart must accept the
Keycloak token's issuer and audience, as for its other first-party clients.
The Keycloak token endpoint must permit browser requests from the Stalwart
origin; enabling CIMD alone does not replace the realm's trust and CORS policy.

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
sessions in Chromium and WebKit.
The screenshots are written to `dist/`.

Live Keycloak/Stalwart integration and installation of a browser-generated file
still need to be verified against the actual deployment and on an Apple device.
A downloaded file does not by itself confirm that Apple installed the profile.

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
