import { fetchJSON } from "./api.js";
import { httpsURL } from "./profile.js";

const TRANSACTION_KEY = "stalwart-mobileconfig.oauth";
const MAX_TRANSACTION_AGE = 10 * 60 * 1000;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64URL(bytes);
}

function base64URL(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64URL(new Uint8Array(digest));
}

export async function discoverAuthorization(origin, fetcher = fetch) {
  const resource = await fetchJSON(`${origin}/.well-known/oauth-protected-resource`, {}, fetcher);
  const issuer = httpsURL(resource.authorization_servers?.[0], "Identity-provider issuer").href.replace(/\/$/u, "");
  const metadata = await fetchJSON(`${issuer}/.well-known/openid-configuration`, {}, fetcher);
  if (metadata.issuer?.replace(/\/$/u, "") !== issuer) {
    throw new Error("The identity-provider metadata does not match its advertised issuer.");
  }
  if (metadata.client_id_metadata_document_supported !== true) {
    throw new Error("Enable Client ID Metadata Documents (CIMD) on your identity provider to use this app.");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Your identity provider must support PKCE with S256.");
  }
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: httpsURL(metadata.authorization_endpoint, "Authorization endpoint").href,
    tokenEndpoint: httpsURL(metadata.token_endpoint, "Token endpoint").href,
    requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
    scopes: Array.isArray(metadata.stalwart_required_scopes)
      ? metadata.stalwart_required_scopes.filter((scope) => typeof scope === "string" && scope)
      : metadata.scopes_supported?.includes("openid") ? ["openid"] : [],
    resource: origin,
  };
}

export async function startSignIn(baseURL, storage = sessionStorage, fetcher = fetch) {
  const base = httpsURL(baseURL, "Application URL");
  const discovery = await discoverAuthorization(base.origin, fetcher);
  const verifier = randomToken();
  const state = randomToken();
  const clientID = new URL("oauth-client.json", base).href;
  const redirectURI = new URL("index.html", base).href;
  const transaction = {
    ...discovery, verifier, state, clientID, redirectURI, createdAt: Date.now(),
  };
  storage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  const authorizationURL = new URL(discovery.authorizationEndpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientID,
    redirect_uri: redirectURI,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    resource: discovery.resource,
  })) authorizationURL.searchParams.set(key, value);
  if (discovery.scopes.length) authorizationURL.searchParams.set("scope", discovery.scopes.join(" "));
  return authorizationURL.href;
}

export function isCallback(url) {
  const params = new URL(url).searchParams;
  return params.has("code") || params.has("error") || params.has("state");
}

export async function finishSignIn(callbackURL, baseURL, storage = sessionStorage, fetcher = fetch) {
  const stored = storage.getItem(TRANSACTION_KEY);
  storage.removeItem(TRANSACTION_KEY);
  let transaction;
  try {
    transaction = JSON.parse(stored);
  } catch {
    throw new Error("Your sign-in session is missing. Start sign-in again.");
  }
  const base = httpsURL(baseURL, "Application URL");
  const callback = new URL(callbackURL);
  const params = callback.searchParams;
  if (
    !transaction ||
    typeof transaction.state !== "string" ||
    !transaction.state ||
    params.getAll("state").length !== 1 ||
    params.get("state") !== transaction.state ||
    transaction.clientID !== new URL("oauth-client.json", base).href ||
    transaction.redirectURI !== new URL("index.html", base).href ||
    callback.origin + callback.pathname !== transaction.redirectURI ||
    !Number.isFinite(transaction.createdAt) ||
    Date.now() - transaction.createdAt > MAX_TRANSACTION_AGE ||
    Date.now() < transaction.createdAt
  ) {
    throw new Error("Your sign-in session is invalid or expired. Start sign-in again.");
  }
  const responseIssuer = params.get("iss");
  if (params.getAll("iss").length > 1
    || ((transaction.requireIssuer || responseIssuer !== null) && responseIssuer !== transaction.issuer)) {
    throw new Error("The sign-in response came from an unexpected identity provider.");
  }
  if (params.has("error")) throw new Error("Sign-in was not completed. You can try again.");
  if (params.getAll("code").length !== 1 || !params.get("code")) {
    throw new Error("The identity provider did not return an authorization code.");
  }
  const token = await fetchJSON(httpsURL(transaction.tokenEndpoint, "Token endpoint").href, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: transaction.clientID,
      redirect_uri: transaction.redirectURI,
      code: params.get("code"),
      code_verifier: transaction.verifier,
      resource: transaction.resource,
    }),
  }, fetcher);
  if (typeof token.access_token !== "string" || !token.access_token || token.token_type?.toLowerCase() !== "bearer") {
    throw new Error("The identity provider did not return a usable access token.");
  }
  // Tokens are returned to the caller in memory, never written to browser storage.
  return token.access_token;
}

export function clearSignIn(storage = sessionStorage) {
  storage.removeItem(TRANSACTION_KEY);
}
