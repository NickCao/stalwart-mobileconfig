import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CORE, STALWART, CreationUncertainError, DEVICE_PERMISSIONS, HTTPError,
  createAppPassword, discoverConfiguration, fetchJSON, loadAccount,
} from "../../web/api.js";
import { ProfileDownload } from "../../web/workflow.js";

const configuration = JSON.parse(readFileSync(new URL("../fixtures/ua-auto-config.json", import.meta.url)));
const context = {
  accessToken: "access-secret",
  apiURL: "https://mail.example.com/jmap/",
  accountID: "account-id",
  email: "alice@example.com",
};

function creationResponse() {
  return Response.json({ methodResponses: [
    ["x:AppPassword/set", { created: { device: { id: "credential-id", secret: "generated-secret" } } }, "request"],
  ] });
}

test("session discovery binds the profile to the authenticated personal account", async () => {
  const result = await loadAccount("https://mail.example.com", "token", async (url, options) => {
    assert.equal(url, "https://mail.example.com/jmap/session");
    assert.equal(options.headers.Authorization, "Bearer token");
    return Response.json({
      capabilities: { [CORE]: {}, [STALWART]: {} },
      primaryAccounts: { [STALWART]: "own-account" },
      accounts: { "own-account": { isPersonal: true }, "shared-account": { isPersonal: false } },
      username: "Alice@EXAMPLE.COM",
      apiUrl: context.apiURL,
    });
  });
  assert.equal(result.accountID, "own-account");
  assert.equal(result.email, "Alice@example.com");
});

test("a rejected sign-in is distinguished from a later expired session", async () => {
  await assert.rejects(loadAccount("https://mail.example.com", "newly-issued-token", async (url, options) => {
    assert.equal(url, "https://mail.example.com/jmap/session");
    assert.equal(options.headers.Authorization, "Bearer newly-issued-token");
    return new Response("", { status: 401 });
  }), (error) => {
    assert.ok(error instanceof HTTPError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Stalwart did not accept this sign-in/u);
    assert.doesNotMatch(error.message, /expired/u);
    return true;
  });
});

test("a foreign API URL never receives the bearer token", async () => {
  let requests = 0;
  await assert.rejects(loadAccount("https://mail.example.com", "token", async () => {
    requests++;
    return Response.json({
      capabilities: { [STALWART]: {} },
      primaryAccounts: { [STALWART]: "own-account" },
      accounts: { "own-account": { isPersonal: true } },
      username: context.email,
      apiUrl: "https://attacker.example/jmap",
    });
  }), /this Stalwart server/u);
  assert.equal(requests, 1);
});

test("public configuration discovery uses the same origin and carries no bearer token", async () => {
  assert.deepEqual(await discoverConfiguration("https://mail.example.com", async (url, options) => {
    assert.equal(url, "https://mail.example.com/.well-known/user-agent-configuration.json");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(configuration);
  }), configuration);
});

test("password creation uses Stalwart's tagged permission map and excludes account administration", async () => {
  const credential = await createAppPassword(context, "My Mac", async (url, options) => {
    assert.equal(url, context.apiURL);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer access-secret");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.using, [CORE, STALWART]);
    const [method, args] = body.methodCalls[0];
    assert.equal(method, "x:AppPassword/set");
    assert.equal(args.accountId, "account-id");
    assert.equal(args.create.device.description, "My Mac");
    assert.equal(args.create.device.permissions["@type"], "Replace");
    assert.deepEqual(Object.keys(args.create.device.permissions.permissions), DEVICE_PERMISSIONS);
    for (const permission of ["authenticate", "emailSend", "imapAuthenticate", "davCalPropFind", "davCalPut"]) {
      assert.equal(args.create.device.permissions.permissions[permission], true);
    }
    assert.equal(DEVICE_PERMISSIONS.some((permission) => /^(sys|jmap|oauth|sieve|pop3)/u.test(permission)), false);
    return creationResponse();
  });
  assert.equal(credential.secret, "generated-secret");
});

test("double-clicks and repeated downloads create exactly one password", async () => {
  let requests = 0;
  const download = new ProfileDownload(context, configuration, async () => {
    requests++;
    return creationResponse();
  });
  const [first, second] = await Promise.all([
    download.generate({ name: "Alice", deviceName: "My Mac" }),
    download.generate({ name: "Alice", deviceName: "My Mac" }),
  ]);
  assert.equal(requests, 1);
  assert.equal(first, second);
  assert.equal(await download.generate(), first);
  assert.equal(requests, 1);
  assert.equal(first.xml.match(/generated-secret/gu).length, 3);
  assert.equal(first.filename, "alice@example.com.mobileconfig");
});

test("invalid discovery and XML are rejected before a credential is created, and inputs can be corrected", async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return creationResponse(); };
  const invalid = { ...configuration, authentication: { password: false } };
  await assert.rejects(new ProfileDownload(context, invalid, fetcher).generate());
  const download = new ProfileDownload(context, configuration, fetcher);
  await assert.rejects(download.generate({ name: "Bad\u0000name" }), /XML/u);
  assert.equal(requests, 0);
  await download.generate({ name: "Alice" });
  assert.equal(requests, 1);
});

test("a lost creation response blocks retries instead of creating duplicate credentials", async () => {
  for (const response of [
    () => { throw new TypeError("network connection lost"); },
    () => new Response("server error", { status: 503 }),
    () => Response.json({ methodResponses: [] }),
    () => Response.json({ methodResponses: [["x:AppPassword/set", { created: { device: { id: "id" } } }, "request"]] }),
  ]) {
    let requests = 0;
    const download = new ProfileDownload(context, configuration, async () => { requests++; return response(); });
    await assert.rejects(download.generate(), CreationUncertainError);
    await assert.rejects(download.generate(), CreationUncertainError);
    assert.equal(requests, 1);
  }
});

test("a definite quota rejection can be retried without losing the account", async () => {
  let requests = 0;
  const download = new ProfileDownload(context, configuration, async () => {
    requests++;
    return requests === 1
      ? Response.json({ methodResponses: [["x:AppPassword/set", { notCreated: { device: { type: "overQuota" } } }, "request"]] })
      : creationResponse();
  });
  await assert.rejects(download.generate(), /limit/u);
  assert.equal(download.uncertain, false);
  await download.generate();
  assert.equal(requests, 2);
});

test("unauthorized creation requests report an expired session without claiming success", async () => {
  const download = new ProfileDownload(context, configuration, async () => new Response("", { status: 401 }));
  await assert.rejects(download.generate(), /session has expired/u);
  assert.equal(download.result, null);
  assert.equal(download.uncertain, false);
});

test("JSON responses must be objects, valid UTF-8, and within the size limit", async () => {
  for (const response of [
    () => Response.json([]),
    () => new Response("not JSON"),
    () => new Response(new Uint8Array([0xff])),
    () => new Response(" ".repeat(1024 * 1024 + 1)),
  ]) {
    await assert.rejects(fetchJSON("https://example.com", {}, async () => response()));
  }
});
