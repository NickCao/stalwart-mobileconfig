import { emailAddress, httpsURL } from "./profile.js";

export const CORE = "urn:ietf:params:jmap:core";
export const STALWART = "urn:stalwart:jmap";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const MAX_DOCUMENT_BYTES = 1024 * 1024;

export class HTTPError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class CreationUncertainError extends Error {}

export async function fetchJSON(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!response.ok) {
    const message = response.status === 401
      ? "Your session has expired. Sign in again."
      : response.status === 403
        ? "Your account is not allowed to perform this action."
        : `The server returned HTTP ${response.status}.`;
    throw new HTTPError(message, response.status);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength > MAX_DOCUMENT_BYTES) throw new Error("The server response exceeds 1 MiB.");
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Error("The server returned invalid JSON.");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("The server response must be a JSON object.");
  }
  return document;
}

function sameOriginURL(value, origin, field) {
  const url = httpsURL(value, field);
  if (url.origin !== origin) throw new Error(`${field} must be on this Stalwart server.`);
  return url.href;
}

export async function jmapCall(context, method, arguments_, using = [CORE, STALWART], fetcher = fetch) {
  const document = await fetchJSON(context.apiURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ using, methodCalls: [[method, arguments_, "request"]] }),
  }, fetcher);
  const response = document.methodResponses?.find((item) => item[2] === "request");
  if (!response || ![method, "error"].includes(response[0])) {
    throw new Error("Stalwart returned an incomplete JMAP response.");
  }
  if (response[0] === "error") {
    const error = new Error(response[1]?.description || `Stalwart rejected ${method}: ${response[1]?.type || "unknown error"}.`);
    error.jmapType = response[1]?.type;
    throw error;
  }
  return response[1];
}

export async function loadAccount(origin, accessToken, fetcher = fetch) {
  const session = await fetchJSON(`${origin}/jmap/session`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, fetcher);
  if (!session.capabilities?.[STALWART]) {
    throw new Error("This server does not expose Stalwart's account-management API.");
  }
  const accountID = session.primaryAccounts?.[STALWART];
  if (typeof accountID !== "string" || !session.accounts?.[accountID]?.isPersonal) {
    throw new Error("Stalwart did not return your personal account.");
  }
  const context = {
    accessToken,
    accountID,
    apiURL: sameOriginURL(session.apiUrl, origin, "JMAP API URL"),
    email: emailAddress(session.username),
    name: "",
  };
  if (session.capabilities[SUBMISSION] && session.capabilities[MAIL]) {
    try {
      const identities = await jmapCall(context, "Identity/get",
        { accountId: accountID }, [CORE, SUBMISSION], fetcher);
      const identity = identities.list?.find((item) =>
        typeof item.email === "string" && item.email.toLowerCase() === context.email.toLowerCase());
      if (typeof identity?.name === "string") context.name = identity.name;
    } catch (error) {
      // Display-name discovery is optional; an expired session is not.
      if (error instanceof HTTPError && error.status === 401) throw error;
    }
  }
  return context;
}

export function discoverConfiguration(origin, fetcher = fetch) {
  return fetchJSON(`${origin}/.well-known/user-agent-configuration.json`, {}, fetcher);
}

// These protocol permissions deliberately exclude JMAP and account administration.
// CredentialPermissions is Stalwart's tagged Replace object, not an OAuth scope.
export const DEVICE_PERMISSIONS = [
  "authenticate", "emailSend", "calendarSchedulingSend", "calendarSchedulingReceive",
  "imapAuthenticate", "imapAclGet", "imapAclSet", "imapMyRights", "imapListRights",
  "imapAppend", "imapCapability", "imapId", "imapCopy", "imapMove", "imapCreate",
  "imapDelete", "imapEnable", "imapExpunge", "imapFetch", "imapIdle", "imapList",
  "imapLsub", "imapNamespace", "imapRename", "imapSearch", "imapSort", "imapSelect",
  "imapExamine", "imapStatus", "imapStore", "imapSubscribe", "imapThread",
  "imapMetadataGet", "imapMetadataSet", "imapMetadataPrivate",
  "davSyncCollection", "davExpandProperty", "davPrincipalAcl", "davPrincipalList",
  "davPrincipalMatch", "davPrincipalSearch", "davPrincipalSearchPropSet",
  "davCalPropFind", "davCalPropPatch", "davCalGet", "davCalMkCol", "davCalDelete",
  "davCalPut", "davCalCopy", "davCalMove", "davCalLock", "davCalAcl",
  "davCalQuery", "davCalMultiGet", "davCalFreeBusyQuery",
];

export async function createAppPassword(context, label, fetcher = fetch) {
  let response;
  try {
    response = await jmapCall(context, "x:AppPassword/set", {
      accountId: context.accountID,
      create: {
        device: {
          description: label,
          permissions: {
            "@type": "Replace",
            permissions: Object.fromEntries(DEVICE_PERMISSIONS.map((permission) => [permission, true])),
          },
        },
      },
    }, undefined, fetcher);
  } catch (error) {
    if ((error instanceof HTTPError && error.status < 500)
      || (error.jmapType && error.jmapType !== "serverFail")) throw error;
    throw new CreationUncertainError(
      "Stalwart may have created the app password, but its response was lost. "
      + "Check Account → Credentials → App Passwords in Stalwart and remove the unused password before starting again.",
    );
  }
  const credential = response.created?.device;
  if (typeof credential?.id === "string" && typeof credential.secret === "string" && credential.secret) {
    return credential;
  }
  const rejected = response.notCreated?.device;
  if (rejected) {
    const messages = {
      overQuota: "You have reached your app-password limit. Remove an unused password in Stalwart and try again.",
      forbidden: "Your account cannot create a password with the permissions needed for Mail and Calendar.",
      invalidProperties: "Stalwart rejected the app-password settings.",
    };
    throw new Error(messages[rejected.type] || rejected.description || "Stalwart could not create the app password.");
  }
  throw new CreationUncertainError(
    "Stalwart did not return the new app password. Check Account → Credentials → App Passwords before starting again.",
  );
}
