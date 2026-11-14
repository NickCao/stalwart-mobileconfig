import assert from "node:assert/strict";
import test from "node:test";
import { clearSignIn, codeChallenge, finishSignIn, startSignIn } from "../../web/auth.js";

const base = "https://mail.example.com/apple-setup/";
const issuer = "https://id.example.com/realms/mail";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  code_challenge_methods_supported: ["S256"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ["openid", "profile", "email"],
};

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function discovery(overrides = {}) {
  return async (url) => {
    if (url === "https://mail.example.com/.well-known/oauth-protected-resource") {
      return Response.json({ resource: "https://mail.example.com", authorization_servers: [issuer] });
    }
    assert.equal(url, `${issuer}/.well-known/openid-configuration`);
    return Response.json({ ...metadata, ...overrides });
  };
}

async function transaction() {
  const storage = new Storage();
  const authorizationURL = new URL(await startSignIn(base, storage, discovery()));
  const callback = new URL("index.html", base);
  callback.search = new URLSearchParams({
    code: "authorization-code",
    state: authorizationURL.searchParams.get("state"),
    iss: issuer,
  });
  return { storage, authorizationURL, callback };
}

test("PKCE matches RFC 7636's S256 example", async () => {
  assert.equal(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("sign-in discovers Keycloak, uses the installed CIMD URL, and allows existing SSO", async () => {
  const { authorizationURL: url, storage } = await transaction();
  assert.equal(url.origin, "https://id.example.com");
  assert.equal(url.searchParams.get("client_id"), `${base}oauth-client.json`);
  assert.equal(url.searchParams.get("redirect_uri"), `${base}index.html`);
  assert.equal(url.searchParams.get("scope"), "openid");
  assert.equal(url.searchParams.get("resource"), "https://mail.example.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.has("prompt"), false);
  const stored = JSON.parse([...storage.values.values()][0]);
  assert.equal(url.searchParams.get("code_challenge"), await codeChallenge(stored.verifier));
  assert.equal(stored.verifier.length, 43);
});

test("callback exchanges a code once and stores no access or refresh token", async () => {
  const { storage, callback } = await transaction();
  const before = JSON.parse([...storage.values.values()][0]);
  let requests = 0;
  const token = await finishSignIn(callback.href, base, storage, async (url, options) => {
    requests++;
    assert.equal(url, metadata.token_endpoint);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.body.get("client_id"), `${base}oauth-client.json`);
    assert.equal(options.body.get("code_verifier"), before.verifier);
    assert.equal(options.body.get("code"), "authorization-code");
    assert.equal(options.body.has("client_secret"), false);
    return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" });
  });
  assert.equal(token, "access-secret");
  assert.equal(storage.values.size, 0);
  await assert.rejects(finishSignIn(callback.href, base, storage, () => { requests++; }), /invalid|missing/u);
  assert.equal(requests, 1);
});

test("bad state, duplicate parameters, wrong issuer, expired transactions, and wrong paths never reach the token endpoint", async () => {
  for (const mutate of [
    ({ callback }) => callback.searchParams.set("state", "wrong"),
    ({ callback }) => callback.searchParams.append("state", callback.searchParams.get("state")),
    ({ callback }) => callback.searchParams.append("code", "another-code"),
    ({ callback }) => callback.searchParams.set("iss", "https://attacker.example"),
    ({ callback }) => callback.searchParams.append("iss", issuer),
    ({ callback }) => callback.searchParams.delete("iss"),
    ({ callback }) => { callback.pathname = "/other-app/index.html"; },
    ({ storage }) => {
      const [key, value] = [...storage.values.entries()][0];
      storage.setItem(key, JSON.stringify({ ...JSON.parse(value), createdAt: Date.now() - 11 * 60_000 }));
    },
  ]) {
    const context = await transaction();
    mutate(context);
    await assert.rejects(finishSignIn(context.callback.href, base, context.storage,
      () => assert.fail("Invalid callbacks must not exchange a code")));
    assert.equal(context.storage.values.size, 0);
  }
});

test("OAuth denial is handled without exchanging a code", async () => {
  const { storage, callback } = await transaction();
  callback.searchParams.delete("code");
  callback.searchParams.set("error", "access_denied");
  await assert.rejects(finishSignIn(callback.href, base, storage,
    () => assert.fail("Denied sign-in must not exchange a code")), /not completed/u);
});

test("discovery refuses missing CIMD, mismatched issuers, insecure endpoints, and missing PKCE", async () => {
  for (const override of [
    { client_id_metadata_document_supported: false },
    { issuer: "https://attacker.example" },
    { token_endpoint: "http://id.example.com/token" },
    { code_challenge_methods_supported: ["plain"] },
  ]) {
    const storage = new Storage();
    await assert.rejects(startSignIn(base, storage, discovery(override)));
    assert.equal(storage.values.size, 0);
  }
});

test("sign-in works at a different Stalwart installation prefix", async () => {
  const storage = new Storage();
  const url = new URL(await startSignIn("https://mail.example.com/connect/", storage, discovery()));
  assert.equal(url.searchParams.get("client_id"), "https://mail.example.com/connect/oauth-client.json");
  assert.equal(url.searchParams.get("redirect_uri"), "https://mail.example.com/connect/index.html");
  clearSignIn(storage);
  assert.equal(storage.values.size, 0);
});
