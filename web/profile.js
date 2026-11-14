// Apple Mail and CalDAV payloads, matching the Python generator.
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const IDENTIFIER_PREFIX = "io.github.nickcao.stalwart-mobileconfig";

export function hostname(value, field = "hostname") {
  if (typeof value !== "string" || !value || /[/@?#%\s\\]/u.test(value)) {
    throw new Error(`${field} must be a hostname, without a URL or port.`);
  }
  if (value.includes(":")) {
    try {
      const parsed = new URL(`https://[${value}]/`);
      return parsed.hostname.slice(1, -1);
    } catch {
      throw new Error(`${field} must be a hostname, without a URL or port.`);
    }
  }
  const name = value.replace(/\.$/u, "");
  let ascii;
  try {
    ascii = new URL(`https://${name}/`).hostname;
  } catch {
    throw new Error(`${field} must be a hostname.`);
  }
  if (
    ascii.length > 253 ||
    ascii.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new Error(`${field} must be a hostname.`);
  }
  return ascii;
}

export function emailAddress(value) {
  if (typeof value !== "string") throw new Error("This account needs a full email address.");
  const match = /^([a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+)@([^@]+)$/u.exec(value);
  if (!match || match[1].startsWith(".") || match[1].endsWith(".") || match[1].includes("..")) {
    throw new Error("This account needs a full email address, such as user@example.com.");
  }
  const domain = hostname(match[2], "email domain");
  if (domain.includes(":")) throw new Error("This account needs an email domain.");
  return `${match[1]}@${domain}`;
}

export function httpsURL(value, field = "URL") {
  let url;
  try {
    if (typeof value !== "string" || !value) throw new Error();
    url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port === "0") {
      throw new Error();
    }
  } catch {
    throw new Error(`${field} must be an HTTPS URL without credentials or a fragment.`);
  }
  return url;
}

export async function uuidV5(value, namespace = URL_NAMESPACE) {
  const prefix = Uint8Array.from(namespace.replaceAll("-", "").match(/../gu), (byte) => parseInt(byte, 16));
  const text = new TextEncoder().encode(value);
  const input = new Uint8Array(prefix.length + text.length);
  input.set(prefix);
  input.set(text, prefix.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function objectField(parent, key) {
  const value = parent?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The server configuration must contain a ${key} object.`);
  }
  return value;
}

export async function makeProfile(address, document, { name, password } = {}) {
  const email = emailAddress(address);
  const protocols = objectField(document, "protocols");
  const imap = objectField(protocols, "imap");
  const smtp = objectField(protocols, "smtp" in protocols ? "smtp" : "submit");
  const caldav = objectField(protocols, "caldav");
  const imapHost = hostname(imap.host, "IMAP host");
  const smtpHost = hostname(smtp.host, "SMTP host");
  const davURL = httpsURL(caldav.url, "CalDAV URL");
  if (document.authentication !== undefined && document.authentication !== null) {
    const auth = objectField(document, "authentication");
    if (typeof auth.password !== "boolean") {
      throw new Error("The server must advertise whether password authentication is available.");
    }
    if (!auth.password) throw new Error("The server does not advertise password authentication.");
  }

  const advertisedName = document.info?.provider?.name;
  const providerName = typeof advertisedName === "string" && advertisedName.trim()
    ? advertisedName
    : email.split("@")[1];
  const accountID = (await uuidV5(email.toLowerCase())).replaceAll("-", "");
  const profileID = `${IDENTIFIER_PREFIX}.${accountID}`;
  async function payload(kind, type, displayName, settings) {
    const identifier = `${profileID}.${kind}`;
    return {
      PayloadType: type,
      PayloadVersion: 1,
      PayloadIdentifier: identifier,
      PayloadUUID: (await uuidV5(identifier)).toUpperCase(),
      PayloadDisplayName: displayName,
      ...settings,
    };
  }
  const mail = await payload("mail", "com.apple.mail.managed", `Mail: ${email}`, {
    EmailAccountDescription: email,
    EmailAccountName: name || email,
    EmailAccountType: "EmailTypeIMAP",
    EmailAddress: email,
    IncomingMailServerAuthentication: "EmailAuthPassword",
    IncomingMailServerHostName: imapHost,
    IncomingMailServerPortNumber: 993,
    IncomingMailServerUseSSL: true,
    IncomingMailServerUsername: email,
    OutgoingMailServerAuthentication: "EmailAuthPassword",
    OutgoingMailServerHostName: smtpHost,
    OutgoingMailServerPortNumber: 465,
    OutgoingMailServerUseSSL: true,
    OutgoingMailServerUsername: email,
    OutgoingPasswordSameAsIncomingPassword: true,
  });
  const calendar = await payload("caldav", "com.apple.caldav.account", `Calendar: ${email}`, {
    CalDAVAccountDescription: email,
    CalDAVHostName: davURL.hostname.replace(/^\[|\]$/gu, ""),
    CalDAVPort: Number(davURL.port || 443),
    CalDAVPrincipalURL: caldav.url,
    CalDAVUseSSL: true,
    CalDAVUsername: email,
  });
  const profile = {
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: profileID,
    PayloadUUID: (await uuidV5(profileID)).toUpperCase(),
    PayloadDisplayName: `${providerName}: ${email}`,
    PayloadOrganization: providerName,
    PayloadDescription: `Mail and Calendar accounts for ${email}`,
    PayloadScope: "User",
    PayloadContent: [mail, calendar],
  };
  return password === undefined || password === null ? profile : withPassword(profile, password);
}

export function withPassword(profile, password) {
  if (typeof password !== "string") throw new Error("The app password must be a string.");
  const [mail, calendar] = profile.PayloadContent;
  return {
    ...profile,
    PayloadContent: [
      { ...mail, IncomingPassword: password, OutgoingPassword: password },
      { ...calendar, CalDAVPassword: password },
    ],
  };
}

function xmlText(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value)) {
    throw new Error("The profile contains text that cannot be represented in XML.");
  }
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function profileXML(profile) {
  function valueXML(value) {
    if (typeof value === "string") return `<string>${xmlText(value)}</string>`;
    if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
    if (Number.isSafeInteger(value)) return `<integer>${value}</integer>`;
    if (Array.isArray(value)) return `<array>${value.map(valueXML).join("")}</array>`;
    if (value && typeof value === "object") {
      return `<dict>${Object.entries(value).map(([key, item]) =>
        `<key>${xmlText(key)}</key>${valueXML(item)}`).join("")}</dict>`;
    }
    throw new Error("The profile contains an unsupported value.");
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">${valueXML(profile)}</plist>\n`;
}
