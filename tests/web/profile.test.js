import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { emailAddress, hostname, makeProfile, profileXML } from "../../web/profile.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("../fixtures/ua-auto-config.json", import.meta.url)));

function python(code, input) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: `${root}src` },
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("browser payloads and UUIDs match the Python generator", async () => {
  const cases = [
    { email: "Alice@EXAMPLE.COM", document: fixture, options: {} },
    { email: "alice@bücher.example", document: fixture, options: { name: 'Alice & Bob <"Team">', password: ' leading & <"secret">\t' } },
    { email: "alice@example.com", document: {
      ...fixture, info: {}, protocols: {
        imap: { host: "IMAP.EXAMPLE.COM." },
        submit: { host: "smtp.example.com" },
        caldav: { url: "https://dav.example.com:8443/calendars/alice/" },
      },
    }, options: { password: "" } },
  ];
  for (const item of cases) {
    const expected = python(`
import json, sys
from stalwart_mobileconfig.profile import make_profile
data = json.load(sys.stdin)
print(json.dumps(make_profile(data["email"], data["document"], **data["options"])))
`, JSON.stringify(item));
    const actual = await makeProfile(item.email, item.document, item.options);
    assert.deepEqual(actual, expected);
  }
});

test("browser XML round-trips through Apple's plist format with exact passwords and native types", async () => {
  const profile = await makeProfile("alice@example.com", fixture, {
    name: 'Alice & Bob <"Team"> 📨',
    password: ' leading & <"password">\t',
  });
  const parsed = python(`
import json, plistlib, sys
print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))
`, profileXML(profile));
  assert.deepEqual(parsed, profile);
  assert.equal(parsed.PayloadContent[0].IncomingPassword, ' leading & <"password">\t');
  assert.equal(parsed.PayloadContent[0].IncomingMailServerPortNumber, 993);
  assert.equal(parsed.PayloadContent[1].CalDAVUseSSL, true);
});

test("profile identity remains stable across server and display-name changes", async () => {
  const first = await makeProfile("alice@example.com", fixture);
  const changed = structuredClone(fixture);
  changed.protocols.imap.host = "new-imap.example.com";
  const second = await makeProfile("ALICE@EXAMPLE.COM", changed, { name: "Alice" });
  for (const [old, updated] of [[first, second], ...first.PayloadContent.map((value, index) => [value, second.PayloadContent[index]])]) {
    assert.equal(old.PayloadIdentifier, updated.PayloadIdentifier);
    assert.equal(old.PayloadUUID, updated.PayloadUUID);
  }
});

test("passwords are omitted until a credential is supplied", async () => {
  const { PayloadContent: [mail, calendar] } = await makeProfile("alice@example.com", fixture);
  assert.equal("IncomingPassword" in mail, false);
  assert.equal("OutgoingPassword" in mail, false);
  assert.equal("CalDAVPassword" in calendar, false);
  assert.equal(mail.OutgoingPasswordSameAsIncomingPassword, true);
});

test("invalid accounts, protocol hosts, and insecure CalDAV URLs fail validation", async () => {
  for (const address of ["alice", "alice@", "@example.com", "a\nb@example.com", "alice@example.com:443"]) {
    assert.throws(() => emailAddress(address));
  }
  for (const host of ["https://imap.example.com", "imap.example.com:993", "bad host", ""]) {
    assert.throws(() => hostname(host));
  }
  for (const url of ["http://dav.example.com/", "https://user:secret@dav.example.com/", "https://dav.example.com/#fragment", "https://dav.example.com:0/"]) {
    const document = structuredClone(fixture);
    document.protocols.caldav.url = url;
    await assert.rejects(makeProfile("alice@example.com", document));
  }
  for (const protocol of ["imap", "smtp", "caldav"]) {
    const document = structuredClone(fixture);
    delete document.protocols[protocol];
    await assert.rejects(makeProfile("alice@example.com", document));
  }
});

test("OAuth-only providers and invalid XML text are rejected", async () => {
  const document = { ...fixture, authentication: { password: false } };
  await assert.rejects(makeProfile("alice@example.com", document), /password authentication/u);
  const profile = await makeProfile("alice@example.com", fixture, { name: "Invalid\u0000Name" });
  assert.throws(() => profileXML(profile), /XML/u);
});
