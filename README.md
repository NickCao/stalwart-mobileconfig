# stalwart-mobileconfig

Generate an Apple configuration profile for **Mail and CalDAV**, using the
configuration served by Stalwart. Python's `plistlib` writes the XML; there are
no runtime dependencies outside the standard library.

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

For a Keycloak-backed Stalwart account, sign in to the Stalwart WebUI and create
an app password under Account > Credentials > App Passwords. Supply that app
password with `--password` or enter it when the device prompts. This profile
configures password authentication; it does not configure an OAuth/CIMD browser
login flow.

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

```sh
uv sync
uv run python -m unittest discover -s tests -v
uv build
```

The tests run without network access. A live discovery check can be run with
the normal command above. Apple-device installation still needs to be checked
on an actual Mac, iPhone or iPad.

## References

- [Stalwart autoconfiguration](https://stalw.art/docs/server/autoconfig/)
- [PACC draft](https://datatracker.ietf.org/doc/draft-ietf-mailmaint-pacc/)
- [Python plistlib](https://docs.python.org/3/library/plistlib.html)
- [Apple Mail payload](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.mail.managed.yaml)
- [Apple CalDAV payload](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.caldav.account.yaml)
- [Mailcow's Apple profile setup](https://docs.mailcow.email/client/client-apple/)
