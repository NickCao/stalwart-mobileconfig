"""Optional browser integration checks; run with Playwright installed.

All HTTP endpoints are fixtures. No real account or credentials are used.
"""

import argparse
import hashlib
import json
import mimetypes
import plistlib
from base64 import urlsafe_b64encode
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://mail.example.com"
ISSUER = "https://id.example.com/realms/mail"
FIXTURE = json.loads((ROOT / "tests/fixtures/ua-auto-config.json").read_text())
SECRET = ' generated & <"device-secret">\t'


def run_scenario(browser, *, prefix="/apple-setup/", mobile=False, lost_response=False, expired_session=False):
    context = browser.new_context(
        viewport={"width": 390, "height": 844} if mobile else {"width": 1280, "height": 900},
        accept_downloads=True,
        is_mobile=mobile,
        has_touch=mobile,
    )
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    requests = {"creations": 0, "authorization": None}

    def fulfill_json(route, data, status=200):
        route.fulfill(
            status=status,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": ORIGIN},
            body=json.dumps(data),
        )

    def route_request(route):
        request = route.request
        url = urlsplit(request.url)
        path = url.path
        if request.url == f"{ISSUER}/.well-known/openid-configuration":
            fulfill_json(route, {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/auth",
                "token_endpoint": f"{ISSUER}/token",
                "code_challenge_methods_supported": ["S256"],
                "client_id_metadata_document_supported": True,
                "authorization_response_iss_parameter_supported": True,
                "scopes_supported": ["openid"],
            })
        elif request.url.startswith(f"{ISSUER}/auth?"):
            params = parse_qs(url.query)
            assert params["client_id"] == [f"{ORIGIN}{prefix}oauth-client.json"]
            assert params["redirect_uri"] == [f"{ORIGIN}{prefix}index.html"]
            assert params["code_challenge_method"] == ["S256"]
            requests["authorization"] = params
            callback = params["redirect_uri"][0] + "?" + urlencode({
                "code": "fixture-authorization-code",
                "state": params["state"][0],
                "iss": ISSUER,
            })
            route.fulfill(
                content_type="text/html",
                body=f"<script>location.replace({json.dumps(callback)})</script>",
            )
        elif request.url == f"{ISSUER}/token":
            params = parse_qs(request.post_data)
            assert params["code"] == ["fixture-authorization-code"]
            verifier = params["code_verifier"][0].encode()
            challenge = urlsafe_b64encode(hashlib.sha256(verifier).digest()).decode().rstrip("=")
            assert requests["authorization"]["code_challenge"] == [challenge]
            assert params["client_id"] == [f"{ORIGIN}{prefix}oauth-client.json"]
            fulfill_json(route, {"access_token": "fixture-access-token", "token_type": "Bearer"})
        elif url.netloc != "mail.example.com":
            raise AssertionError(f"Unexpected external request: {request.url}")
        elif path == "/.well-known/oauth-protected-resource":
            fulfill_json(route, {"resource": ORIGIN, "authorization_servers": [ISSUER]})
        elif path == "/.well-known/user-agent-configuration.json":
            assert "authorization" not in request.headers
            fulfill_json(route, FIXTURE)
        elif path == "/jmap/session":
            assert request.headers["authorization"] == "Bearer fixture-access-token"
            fulfill_json(route, {
                "capabilities": {
                    "urn:ietf:params:jmap:core": {},
                    "urn:ietf:params:jmap:mail": {},
                    "urn:ietf:params:jmap:submission": {},
                    "urn:stalwart:jmap": {},
                },
                "primaryAccounts": {"urn:stalwart:jmap": "own-account"},
                "accounts": {"own-account": {"isPersonal": True}},
                "username": "alice@example.com",
                "apiUrl": f"{ORIGIN}/jmap/",
            })
        elif path == "/jmap/":
            assert request.headers["authorization"] == "Bearer fixture-access-token"
            method, arguments, call_id = request.post_data_json["methodCalls"][0]
            assert arguments["accountId"] == "own-account"
            if method == "Identity/get":
                fulfill_json(route, {"methodResponses": [[method, {
                    "list": [{"email": "alice@example.com", "name": "Alice & Friends"}],
                }, call_id]]})
            else:
                assert method == "x:AppPassword/set"
                requests["creations"] += 1
                credential = arguments["create"]["device"]
                assert "description" in credential and "name" not in credential
                assert credential["permissions"]["@type"] == "Replace"
                assert credential["permissions"]["permissions"]["imapAuthenticate"] is True
                if expired_session:
                    route.fulfill(status=401, body="fixture expired session")
                elif lost_response:
                    route.fulfill(status=503, body="fixture server failure")
                else:
                    fulfill_json(route, {"methodResponses": [[method, {
                        "created": {"device": {"id": "new-credential", "secret": SECRET}},
                    }, call_id]]})
        elif path.startswith(prefix):
            name = path.removeprefix(prefix) or "index.html"
            file = ROOT / "web" / name
            assert file.is_file() and file.parent == ROOT / "web", request.url
            body = file.read_bytes()
            if name == "index.html":
                # Emulate the application manager's installation-prefix rewrite.
                body = body.replace(b'<base href="/"', f'<base href="{prefix}"'.encode())
            route.fulfill(content_type=mimetypes.guess_type(file)[0] or "text/plain", body=body)
        else:
            raise AssertionError(f"Unexpected request: {request.url}")

    page.route("**/*", route_request)
    page.goto(f"{ORIGIN}{prefix}")
    expect(page.get_by_role("button", name="Sign in to continue")).to_be_visible()
    assert requests["creations"] == 0
    if not mobile and not lost_response and not expired_session:
        page.screenshot(path=str(ROOT / "dist/preview-desktop.png"), full_page=True)
    page.get_by_role("button", name="Sign in to continue").click()
    expect(page.get_by_role("button", name="Download setup profile")).to_be_visible()
    expect(page.locator("#account-email")).to_have_text("alice@example.com")
    expect(page.get_by_label("Name on outgoing mail")).to_have_value("Alice & Friends")
    assert requests["creations"] == 0, "Sign-in must never create an app password"
    assert page.url == f"{ORIGIN}{prefix}", "Authorization parameters must be removed"
    assert page.evaluate("sessionStorage.length") == 0
    assert page.evaluate("localStorage.length") == 0
    if mobile:
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(ROOT / "dist/preview-mobile.png"), full_page=True)
    if expired_session:
        page.get_by_role("button", name="Download setup profile").click()
        expect(page.get_by_role("alert")).to_contain_text("session has expired")
        expect(page.get_by_role("button", name="Sign in to continue")).to_be_visible()
        assert requests["creations"] == 1
    elif lost_response:
        page.get_by_role("button", name="Download setup profile").click()
        expect(page.get_by_role("alert")).to_contain_text("response was lost")
        expect(page.get_by_role("button", name="Download setup profile")).to_be_disabled()
        assert requests["creations"] == 1
    else:
        page.get_by_label("Name on outgoing mail").fill('Alice & Bob <"Team">')
        with page.expect_download() as first_download:
            page.get_by_role("button", name="Download setup profile").click()
        downloaded = first_download.value
        assert downloaded.suggested_filename == "alice@example.com.mobileconfig"
        profile = plistlib.loads(Path(downloaded.path()).read_bytes())
        mail, calendar = profile["PayloadContent"]
        assert mail["EmailAccountName"] == 'Alice & Bob <"Team">'
        assert mail["IncomingPassword"] == mail["OutgoingPassword"] == calendar["CalDAVPassword"] == SECRET
        assert mail["IncomingMailServerPortNumber"] == 993
        assert calendar["CalDAVPrincipalURL"] == FIXTURE["protocols"]["caldav"]["url"]
        with page.expect_download() as second_download:
            page.get_by_role("link", name="Download again").click()
        assert Path(second_download.value.path()).read_bytes() == Path(downloaded.path()).read_bytes()
        assert requests["creations"] == 1
        if not mobile:
            page.screenshot(path=str(ROOT / "dist/preview-ready.png"), full_page=True)
        page.get_by_role("button", name="Done · Sign out").click()
        expect(page.get_by_role("button", name="Sign in to continue")).to_be_visible()
        assert page.locator("#download-link").get_attribute("href") is None
    assert not errors, errors
    print(f"PASS browser: {prefix} mobile={mobile} lost_response={lost_response} expired_session={expired_session}")
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=("chromium", "webkit"), default="chromium")
    args = parser.parse_args()
    (ROOT / "dist").mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.browser).launch()
        run_scenario(browser)
        run_scenario(browser, prefix="/connect/", mobile=True)
        run_scenario(browser, lost_response=True)
        run_scenario(browser, expired_session=True)
        browser.close()


if __name__ == "__main__":
    main()
