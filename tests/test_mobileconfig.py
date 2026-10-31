import contextlib
import copy
import io
import json
import plistlib
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import Request

from stalwart_mobileconfig.cli import main
from stalwart_mobileconfig.configuration import (
    MAX_DOCUMENT_SIZE,
    ConfigurationError,
    HTTPSRedirectHandler,
    configuration_url,
    discover,
)
from stalwart_mobileconfig.profile import make_profile

FIXTURE = Path(__file__).parent / "fixtures" / "ua-auto-config.json"


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads(FIXTURE.read_bytes())

    def test_discovered_settings_populate_only_mail_and_calendar(self):
        profile = make_profile("alice@example.com", self.document)
        mail, calendar = profile["PayloadContent"]
        self.assertEqual(mail["PayloadType"], "com.apple.mail.managed")
        self.assertEqual(calendar["PayloadType"], "com.apple.caldav.account")
        self.assertEqual(mail["IncomingMailServerHostName"], "imap.example.com")
        self.assertEqual(mail["OutgoingMailServerHostName"], "smtp.example.com")
        self.assertEqual(mail["IncomingMailServerPortNumber"], 993)
        self.assertEqual(mail["OutgoingMailServerPortNumber"], 465)
        self.assertTrue(mail["IncomingMailServerUseSSL"])
        self.assertTrue(mail["OutgoingMailServerUseSSL"])
        self.assertEqual(calendar["CalDAVHostName"], "dav.example.com")
        self.assertEqual(
            calendar["CalDAVPrincipalURL"], "https://dav.example.com/calendars/"
        )
        self.assertEqual(calendar["CalDAVPort"], 443)
        self.assertTrue(calendar["CalDAVUseSSL"])
        self.assertEqual(profile["PayloadOrganization"], "Example & Friends")
        self.assertEqual(mail["IncomingMailServerUsername"], "alice@example.com")
        self.assertEqual(mail["OutgoingMailServerUsername"], "alice@example.com")
        self.assertEqual(calendar["CalDAVUsername"], "alice@example.com")
        self.assertEqual(mail["EmailAccountName"], "alice@example.com")

    def test_passwords_are_omitted_and_smtp_reuses_the_mail_password(self):
        mail, calendar = make_profile("alice@example.com", self.document)[
            "PayloadContent"
        ]
        self.assertNotIn("IncomingPassword", mail)
        self.assertNotIn("OutgoingPassword", mail)
        self.assertNotIn("CalDAVPassword", calendar)
        self.assertTrue(mail["OutgoingPasswordSameAsIncomingPassword"])

    def test_profile_identity_survives_server_updates(self):
        first = make_profile("alice@example.com", self.document)
        changed = copy.deepcopy(self.document)
        changed["protocols"]["imap"]["host"] = "new-imap.example.com"
        second = make_profile("alice@example.com", changed)
        for old, new in zip(
            [first, *first["PayloadContent"]], [second, *second["PayloadContent"]]
        ):
            self.assertEqual(old["PayloadIdentifier"], new["PayloadIdentifier"])
            self.assertEqual(old["PayloadUUID"], new["PayloadUUID"])
            uuid.UUID(old["PayloadUUID"])
        other = make_profile("bob@example.com", self.document)
        self.assertNotEqual(first["PayloadIdentifier"], other["PayloadIdentifier"])

    def test_xml_escapes_names_and_preserves_native_types(self):
        profile = make_profile(
            "alice@example.com", self.document, 'Alice & Bob <"Team">'
        )
        data = plistlib.dumps(profile, fmt=plistlib.FMT_XML)
        self.assertEqual(plistlib.loads(data), profile)
        self.assertIn(b"&amp;", data)
        self.assertIn(b"&lt;", data)

    def test_current_pacc_submission_name_is_supported(self):
        self.document["protocols"]["submit"] = self.document["protocols"].pop("smtp")
        mail = make_profile("alice@example.com", self.document)["PayloadContent"][0]
        self.assertEqual(mail["OutgoingMailServerHostName"], "smtp.example.com")

    def test_required_protocols_must_be_present(self):
        for protocol in ("imap", "smtp", "caldav"):
            with self.subTest(protocol=protocol):
                document = copy.deepcopy(self.document)
                del document["protocols"][protocol]
                with self.assertRaises(ConfigurationError):
                    make_profile("alice@example.com", document)

    def test_oauth_only_provider_cannot_produce_a_password_profile(self):
        self.document["authentication"]["password"] = False
        with self.assertRaisesRegex(ConfigurationError, "password authentication"):
            make_profile("alice@example.com", self.document)

    def test_invalid_protocol_hosts_and_urls_are_rejected(self):
        for host in (
            "https://imap.example.com",
            "imap.example.com:993",
            "bad host",
            "",
        ):
            with self.subTest(host=host):
                document = copy.deepcopy(self.document)
                document["protocols"]["imap"]["host"] = host
                with self.assertRaises(ConfigurationError):
                    make_profile("alice@example.com", document)
        for url in (
            "http://dav.example.com/",
            "https://user:secret@dav.example.com/",
            "https://dav.example.com/#fragment",
            "https://dav.example.com:0/",
            "",
        ):
            with self.subTest(url=url):
                document = copy.deepcopy(self.document)
                document["protocols"]["caldav"]["url"] = url
                with self.assertRaises(ConfigurationError):
                    make_profile("alice@example.com", document)


class Response(io.BytesIO):
    def geturl(self):
        return "https://ua-auto-config.example.com/.well-known/user-agent-configuration.json"


class DiscoveryTests(unittest.TestCase):
    def test_discovery_uses_the_email_domain(self):
        self.assertEqual(
            configuration_url("alice@EXAMPLE.COM"),
            "https://ua-auto-config.example.com/.well-known/user-agent-configuration.json",
        )
        self.assertEqual(
            configuration_url("alice@b\u00fccher.example"),
            "https://ua-auto-config.xn--bcher-kva.example/.well-known/user-agent-configuration.json",
        )

    def test_invalid_email_is_rejected_before_discovery(self):
        for email in (
            "alice",
            "alice@",
            "@example.com",
            "alice@example.com:443",
            "a\nb@example.com",
        ):
            with self.subTest(email=email), self.assertRaises(ConfigurationError):
                configuration_url(email)

    @patch("stalwart_mobileconfig.configuration.build_opener")
    def test_fetches_json_with_a_timeout(self, build_opener):
        build_opener.return_value.open.return_value = Response(FIXTURE.read_bytes())
        self.assertEqual(
            discover("alice@example.com"), json.loads(FIXTURE.read_bytes())
        )
        args, kwargs = build_opener.return_value.open.call_args
        self.assertEqual(args[0].full_url, configuration_url("alice@example.com"))
        self.assertEqual(kwargs["timeout"], 15)

    def test_http_redirect_downgrades_are_rejected(self):
        with self.assertRaises(ConfigurationError):
            HTTPSRedirectHandler().redirect_request(
                Request("https://ua-auto-config.example.com/"),
                None,
                302,
                "Found",
                {},
                "http://ua-auto-config.example.com/config.json",
            )

    @patch("stalwart_mobileconfig.configuration.build_opener")
    def test_malformed_and_oversized_documents_are_rejected(self, build_opener):
        for data in (b"not JSON", b"[]", b" " * (MAX_DOCUMENT_SIZE + 1)):
            with self.subTest(size=len(data)):
                build_opener.return_value.open.return_value = Response(data)
                with self.assertRaises(ConfigurationError):
                    discover("alice@example.com")


class CliTests(unittest.TestCase):
    @patch("stalwart_mobileconfig.cli.discover")
    def test_command_writes_a_complete_xml_profile(self, discover):
        discover.return_value = json.loads(FIXTURE.read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alice.mobileconfig"
            main(["alice@example.com", "--name", "Alice", "-o", str(path)])
            profile = plistlib.loads(path.read_bytes())
        self.assertEqual(profile["PayloadContent"][0]["EmailAccountName"], "Alice")
        discover.assert_called_once_with("alice@example.com")

    @patch(
        "stalwart_mobileconfig.cli.discover", side_effect=URLError("connection failed")
    )
    def test_fetch_failure_preserves_existing_output(self, discover):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing.mobileconfig"
            path.write_bytes(b"existing profile")
            stderr = io.StringIO()
            with (
                contextlib.redirect_stderr(stderr),
                self.assertRaises(SystemExit) as failure,
            ):
                main(["alice@example.com", "-o", str(path)])
            self.assertEqual(failure.exception.code, 1)
            self.assertEqual(path.read_bytes(), b"existing profile")
            self.assertIn("connection failed", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
