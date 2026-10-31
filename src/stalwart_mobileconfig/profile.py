"""Build Apple's managed Mail and CalDAV payloads."""

import uuid
from email.headerregistry import Address

from .configuration import ConfigurationError, email_address, hostname, https_url


def object_field(parent: dict, name: str) -> dict:
    value = parent.get(name)
    if not isinstance(value, dict):
        raise ConfigurationError(f"configuration must contain a {name} object")
    return value


def make_profile(
    email: str,
    document: dict,
    name: str | None = None,
    password: str | None = None,
) -> dict:
    email = email_address(email)
    protocols = object_field(document, "protocols")
    imap = object_field(protocols, "imap")
    # Stalwart 1.0 uses "smtp"; newer PACC drafts call submission "submit".
    smtp = object_field(protocols, "smtp" if "smtp" in protocols else "submit")
    caldav = object_field(protocols, "caldav")
    imap_host = hostname(imap.get("host"), "protocols.imap.host")
    smtp_host = hostname(smtp.get("host"), "protocols.smtp.host")
    dav_url = https_url(caldav.get("url"), "protocols.caldav.url")

    authentication = document.get("authentication")
    if authentication is not None:
        if (
            not isinstance(authentication, dict)
            or type(authentication.get("password")) is not bool
        ):
            raise ConfigurationError("authentication.password must be a boolean")
        if not authentication["password"]:
            raise ConfigurationError(
                "the provider does not advertise password authentication"
            )

    info = document.get("info", {})
    provider = info.get("provider", {}) if isinstance(info, dict) else {}
    provider_name = provider.get("name") if isinstance(provider, dict) else None
    if not isinstance(provider_name, str) or not provider_name.strip():
        provider_name = Address(addr_spec=email).domain

    account_id = uuid.uuid5(uuid.NAMESPACE_URL, email.casefold()).hex
    profile_id = f"io.github.nickcao.stalwart-mobileconfig.{account_id}"
    description = f"{provider_name}: {email}"

    def payload(kind: str, payload_type: str, display_name: str, **settings) -> dict:
        identifier = f"{profile_id}.{kind}"
        return {
            "PayloadType": payload_type,
            "PayloadVersion": 1,
            "PayloadIdentifier": identifier,
            "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_URL, identifier)).upper(),
            "PayloadDisplayName": display_name,
            **settings,
        }

    mail = payload(
        "mail",
        "com.apple.mail.managed",
        f"Mail: {email}",
        EmailAccountDescription=email,
        EmailAccountName=name or email,
        EmailAccountType="EmailTypeIMAP",
        EmailAddress=email,
        IncomingMailServerAuthentication="EmailAuthPassword",
        IncomingMailServerHostName=imap_host,
        IncomingMailServerPortNumber=993,
        IncomingMailServerUseSSL=True,
        IncomingMailServerUsername=email,
        OutgoingMailServerAuthentication="EmailAuthPassword",
        OutgoingMailServerHostName=smtp_host,
        OutgoingMailServerPortNumber=465,
        OutgoingMailServerUseSSL=True,
        OutgoingMailServerUsername=email,
        OutgoingPasswordSameAsIncomingPassword=True,
    )
    calendar = payload(
        "caldav",
        "com.apple.caldav.account",
        f"Calendar: {email}",
        CalDAVAccountDescription=email,
        CalDAVHostName=hostname(dav_url.hostname, "protocols.caldav.url"),
        CalDAVPort=dav_url.port or 443,
        CalDAVPrincipalURL=caldav["url"],
        CalDAVUseSSL=True,
        CalDAVUsername=email,
    )
    if password is not None:
        mail["IncomingPassword"] = password
        mail["OutgoingPassword"] = password
        calendar["CalDAVPassword"] = password

    return {
        "PayloadType": "Configuration",
        "PayloadVersion": 1,
        "PayloadIdentifier": profile_id,
        "PayloadUUID": str(uuid.uuid5(uuid.NAMESPACE_URL, profile_id)).upper(),
        "PayloadDisplayName": description,
        "PayloadOrganization": provider_name,
        "PayloadDescription": f"Mail and Calendar accounts for {email}",
        "PayloadScope": "User",
        "PayloadContent": [mail, calendar],
    }
