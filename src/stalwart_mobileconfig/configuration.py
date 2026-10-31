"""Read the settings advertised by Stalwart, without requesting credentials."""

import ipaddress
import json
import re
from email.errors import HeaderParseError
from email.headerregistry import Address
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_DOCUMENT_SIZE = 1024 * 1024


class ConfigurationError(ValueError):
    """The email address or configuration cannot produce an account profile."""


def hostname(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{field} must be a hostname")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    try:
        ascii_name = value.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ConfigurationError(f"{field} must be a hostname") from error
    labels = ascii_name.split(".")
    if len(ascii_name) > 253 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise ConfigurationError(f"{field} must be a hostname, without a URL or port")
    return ascii_name


def email_address(value: str) -> str:
    try:
        address = Address(addr_spec=value)
    except (ValueError, IndexError, HeaderParseError) as error:
        raise ConfigurationError(
            "provide a full email address, such as user@example.com"
        ) from error
    if not address.username or not address.domain:
        raise ConfigurationError(
            "provide a full email address, such as user@example.com"
        )
    domain = hostname(address.domain, "email domain")
    return str(Address(username=address.username, domain=domain))


def configuration_url(email: str) -> str:
    domain = Address(addr_spec=email_address(email)).domain
    return f"https://ua-auto-config.{domain}/.well-known/user-agent-configuration.json"


def https_url(value: object, field: str):
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{field} must be an HTTPS URL")
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
            and (parsed.port is None or 1 <= parsed.port <= 65535)
        )
    except ValueError as error:
        raise ConfigurationError(f"{field} must be an HTTPS URL") from error
    if not valid:
        raise ConfigurationError(
            f"{field} must be an HTTPS URL without credentials or a fragment"
        )
    hostname(parsed.hostname, field)
    return parsed


class HTTPSRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        https_url(new_url, "configuration redirect")
        return super().redirect_request(
            request, response, code, message, headers, new_url
        )


def discover(email: str) -> dict:
    request = Request(
        configuration_url(email),
        headers={
            "Accept": "application/json",
            "User-Agent": "stalwart-mobileconfig/0.1.0",
        },
    )
    # urllib's default HTTPS handler verifies the certificate and hostname.
    with build_opener(HTTPSRedirectHandler()).open(request, timeout=15) as response:
        https_url(response.geturl(), "configuration URL")
        data = response.read(MAX_DOCUMENT_SIZE + 1)
    if len(data) > MAX_DOCUMENT_SIZE:
        raise ConfigurationError("configuration document exceeds 1 MiB")
    try:
        document = json.loads(data)
    except (ValueError, UnicodeError) as error:
        raise ConfigurationError("configuration document is not valid JSON") from error
    if not isinstance(document, dict):
        raise ConfigurationError("configuration document must be a JSON object")
    return document
