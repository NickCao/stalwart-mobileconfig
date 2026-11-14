"""Exercise the app against an isolated Stalwart 1.1.0 server.

Requires a Stalwart executable, OpenSSL, and Python Playwright with Chromium
and WebKit installed. Uses temporary SQLite state and test credentials.
Stalwart's own OAuth provider handles sign-in; this does not run Keycloak.
"""

import argparse
import base64
import imaplib
import json
import os
from pathlib import Path
import plistlib
import secrets
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
STALWART = "urn:stalwart:jmap"
CORE = "urn:ietf:params:jmap:core"
EMAIL = "alice@example.test"
DISPLAY_NAME = 'Alice & Bob <"Team">'
sys.path.insert(0, str(ROOT / "src"))
from stalwart_mobileconfig.profile import make_profile  # noqa: E402


def basic_auth(username, password):
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


def free_ports(count):
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


class Server:
    def __init__(self, binary, directory):
        self.binary = binary
        self.directory = directory
        self.http_port, self.https_port, self.imap_port, self.smtp_port = free_ports(4)
        self.origin = f"https://127.0.0.1:{self.https_port}"
        self.admin_origin = f"http://127.0.0.1:{self.http_port}"
        self.admin_auth = basic_auth("bootstrap", secrets.token_urlsafe(32))
        self.config = directory / "config.json"
        self.config.write_text(json.dumps({
            "@type": "Sqlite", "path": str(directory / "data.sqlite3"),
            "poolWorkers": 2, "poolMaxConnections": 4,
        }))
        self.process = None
        self.tls = None

    def start(self, recovery):
        admin = base64.b64decode(self.admin_auth.removeprefix("Basic ")).decode()
        environment = {
            **os.environ,
            "CONFIG_PATH": str(self.config),
            "STALWART_RECOVERY_MODE": str(int(recovery)),
            "STALWART_RECOVERY_MODE_PORT": str(self.http_port),
            "STALWART_RECOVERY_ADMIN": admin,
            "STALWART_PUBLIC_URL": self.origin,
            "STALWART_HOSTNAME": "127.0.0.1",
            "TOKIO_WORKER_THREADS": "2",
            "TMPDIR": str(self.directory),
        }
        with (self.directory / "server.log").open("ab") as log:
            self.process = subprocess.Popen(
                [str(self.binary), "--config", str(self.config)],
                env=environment, stdout=log, stderr=log,
            )
        for _ in range(150):
            if self.process.poll() is not None:
                raise RuntimeError("Stalwart exited during startup")
            try:
                self.request("/healthz/live", authorization=None)
                return
            except (OSError, URLError):
                time.sleep(0.2)
        raise RuntimeError("Stalwart startup timed out")

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None

    def request(self, path, *, data=None, authorization=None, origin=None):
        headers = {"Authorization": authorization} if authorization else {}
        if data is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(data).encode()
        request = Request((origin or self.admin_origin) + path, headers=headers, data=data)
        with urlopen(request, timeout=10, context=self.tls) as response:
            return response.read()

    def jmap(self, method, arguments):
        document = json.loads(self.request("/jmap/", authorization=self.admin_auth, data={
            "using": [CORE, STALWART],
            "methodCalls": [[method, arguments, "test"]],
        }))
        response, body, _ = document["methodResponses"][0]
        assert response == method, (response, body)
        assert not body.get("notCreated") and not body.get("notUpdated"), body
        return body

    def create(self, kind, value):
        body = self.jmap("x:" + kind + "/set", {"create": {"test": value}})
        return body["created"]["test"]["id"]

    def setup(self):
        # Provision only this temporary server through its recovery interface.
        apps = self.jmap("x:Application/get", {})["list"]
        self.jmap("x:Application/set", {
            "update": {app["id"]: {"enable": False} for app in apps},
        })
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(self.directory / "key.pem"),
            "-out", str(self.directory / "cert.pem"),
            "-days", "1", "-subj", "/CN=127.0.0.1",
            "-addext", "subjectAltName=IP:127.0.0.1",
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.tls = ssl.create_default_context(cafile=str(self.directory / "cert.pem"))
        certificate = self.create("Certificate", {
            "certificate": {"@type": "File", "filePath": str(self.directory / "cert.pem")},
            "privateKey": {"@type": "File", "filePath": str(self.directory / "key.pem")},
        })
        domain = self.create("Domain", {
            "name": "example.test", "enable": True,
            "certificateManagement": {"@type": "Manual"},
            "dkimManagement": {"@type": "Manual"},
            "dnsManagement": {"@type": "Manual"},
        })
        for name, port, protocol, tls in [
            ("admin", self.http_port, "http", False),
            ("https", self.https_port, "http", True),
            ("imaps", self.imap_port, "imap", True),
            ("submissions", self.smtp_port, "smtp", True),
        ]:
            self.create("NetworkListener", {
                "name": name, "bind": {f"127.0.0.1:{port}": True},
                "protocol": protocol, "implicitTls": tls,
            })
        self.jmap("x:SystemSettings/set", {"update": {"singleton": {
            "defaultHostname": "127.0.0.1",
            "defaultDomainId": domain, "defaultCertificateId": certificate,
            "services": {name: {} for name in ["jmap", "imap", "smtp", "caldav"]},
        }}})
        bundle = self.directory / "app.zip"
        subprocess.run([
            sys.executable, str(ROOT / "scripts/build_webapp.py"), "--output", str(bundle),
        ], cwd=ROOT, check=True)
        self.create("Application", {
            "description": "Mobileconfig integration test", "enable": True,
            "resourceUrl": bundle.as_uri(),
            "urlPrefix": {"/apple-setup": True, "/connect": True},
            "unpackDirectory": str(self.directory / "apps"),
        })
        return domain

    def create_user(self, domain):
        password = secrets.token_urlsafe(32)
        account_id = self.create("Account", {
            "@type": "User", "name": "alice", "domainId": domain,
            "description": "Alice & Friends",
            "credentials": {"0": {"@type": "Password", "secret": password}},
        })
        return account_id, password


def check_password(server, password):
    with imaplib.IMAP4_SSL(
        "127.0.0.1", server.imap_port, ssl_context=server.tls, timeout=10,
    ) as imap:
        assert imap.login(EMAIL, password)[0] == "OK"
        assert imap.select("INBOX")[0] == "OK"
    with smtplib.SMTP_SSL(
        "127.0.0.1", server.smtp_port, context=server.tls, timeout=10,
    ) as smtp:
        assert smtp.login(EMAIL, password)[0] == 235
    request = Request(server.origin + "/dav/cal/", method="PROPFIND", headers={
        "Authorization": basic_auth(EMAIL, password), "Depth": "0",
    })
    with urlopen(request, context=server.tls, timeout=10) as response:
        assert response.status == 207

    # A device credential must not be able to create another credential.
    document = json.loads(server.request(
        "/jmap/", origin=server.origin, authorization=basic_auth(EMAIL, password), data={
            "using": [CORE, STALWART],
            "methodCalls": [["x:AppPassword/set", {
                "create": {"unexpected": {"description": "Must be forbidden"}},
            }, "test"]],
        },
    ))
    method, error, _ = document["methodResponses"][0]
    assert method == "error" and error["type"] == "forbidden", (method, error)


def run(server, account_id, password, browser_name, prefix, count):
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        # Browsers use only this context's temporary self-signed test certificate.
        context = browser.new_context(ignore_https_errors=True, accept_downloads=True)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        client_url = server.origin + prefix + "oauth-client.json"
        client = json.loads(server.request(client_url.removeprefix(server.origin), origin=server.origin))
        assert client["client_id"] == client_url
        assert client["redirect_uris"] == [server.origin + prefix + "index.html"]
        assert client["token_endpoint_auth_method"] == "none"
        page.goto(server.origin + prefix)
        page.get_by_role("button", name="Sign in to continue").click()
        page.locator("#username").fill(EMAIL)
        page.locator("#password").fill(password)
        with page.expect_response(server.origin + "/jmap/session") as event:
            page.locator("#submit-btn").click()
        session = event.value.json()
        assert STALWART not in session["capabilities"]
        assert session["primaryAccounts"][STALWART] == account_id
        assert STALWART in session["accounts"][account_id]["accountCapabilities"]
        expect(page.get_by_role("button", name="Download setup profile")).to_be_visible()
        expect(page.locator("#account-email")).to_have_text(EMAIL)
        expect(page.get_by_label("Name on outgoing mail")).to_have_value("Alice & Friends")
        assert len(server.jmap("x:AppPassword/get", {"accountId": account_id})["list"]) == count - 1
        permissions = page.evaluate(
            "async () => (await import('./api.js')).DEVICE_PERMISSIONS"
        )
        page.get_by_label("Name on outgoing mail").fill(DISPLAY_NAME)
        with page.expect_download() as event:
            page.get_by_role("button", name="Download setup profile").click()
        download = event.value
        assert download.suggested_filename == EMAIL + ".mobileconfig"
        downloaded = Path(download.path()).read_bytes()
        profile = plistlib.loads(downloaded)
        credential = profile["PayloadContent"][0]["IncomingPassword"]
        assert credential.startswith("app_")
        configuration = json.loads(server.request(
            "/.well-known/user-agent-configuration.json", origin=server.origin,
        ))
        assert profile == make_profile(EMAIL, configuration, name=DISPLAY_NAME, password=credential)
        with page.expect_download() as event:
            page.get_by_role("link", name="Download again").click()
        assert Path(event.value.path()).read_bytes() == downloaded
        credentials = server.jmap("x:AppPassword/get", {"accountId": account_id})["list"]
        assert len(credentials) == count
        for item in credentials:
            assert item["permissions"] == {
                "@type": "Replace", "permissions": dict.fromkeys(permissions, True),
            }
            assert item["description"].startswith("Apple Mail & Calendar — ")
        check_password(server, credential)
        assert not errors, errors
        page.get_by_role("button", name="Done · Sign out").click()
        expect(page.get_by_role("button", name="Sign in to continue")).to_be_visible()
        assert page.evaluate("sessionStorage.length + localStorage.length") == 0
        print(f"PASS real Stalwart: {browser_name} {prefix}; OAuth, CIMD, PACC, profile parity, "
              "credential permissions, IMAP, SMTP, CalDAV, and repeated download", flush=True)
        context.close()
        browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stalwart", type=Path, required=True, help="Path to Stalwart 1.1.0")
    args = parser.parse_args()
    binary = args.stalwart.resolve(strict=True)
    version_environment = dict(os.environ)
    version_environment.pop("CONFIG_PATH", None)
    assert subprocess.check_output(
        [str(binary), "--version"], text=True, env=version_environment, timeout=10,
    ).strip() == "1.1.0"
    with tempfile.TemporaryDirectory(prefix="stalwart-mobileconfig-") as temporary:
        server = Server(binary, Path(temporary))
        try:
            server.start(recovery=True)
            domain = server.setup()
            server.stop()
            server.start(recovery=False)
            account_id, password = server.create_user(domain)
            run(server, account_id, password, "chromium", "/apple-setup/", 1)
            run(server, account_id, password, "webkit", "/connect/", 2)
        except Exception:
            print((server.directory / "server.log").read_text()[-12000:], file=sys.stderr)
            raise
        finally:
            server.stop()


if __name__ == "__main__":
    main()
