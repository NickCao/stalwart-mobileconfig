import { clearSignIn, finishSignIn, isCallback, startSignIn } from "./auth.js";
import { CreationUncertainError, HTTPError, discoverConfiguration, loadAccount } from "./api.js";
import { makeProfile, profileXML } from "./profile.js";
import { ProfileDownload } from "./workflow.js";

const baseURL = new URL("./", import.meta.url);
const element = (id) => document.getElementById(id);
let workflow = null;
let downloadURL = null;
let busy = false;

function setBusy(value, message = "") {
  busy = value;
  element("status").textContent = message;
  document.querySelector(".setup-card").setAttribute("aria-busy", String(value));
  for (const id of ["signin-button", "generate-button", "signout-button", "done-signout-button"]) {
    element(id).disabled = value;
  }
  for (const id of ["signin-button", "generate-button"]) {
    element(id).setAttribute("aria-busy", String(value));
  }
  for (const id of ["device-name", "display-name"]) element(id).disabled = value;
}

function showError(error) {
  element("notice").textContent = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  element("notice").hidden = false;
}

function clearError() {
  element("notice").hidden = true;
  element("notice").textContent = "";
}

function setStep(id) {
  for (const item of document.querySelectorAll(".steps li")) item.removeAttribute("aria-current");
  element(id).setAttribute("aria-current", "step");
}

function deviceName() {
  if (/iPad/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "My iPad";
  if (/iPhone/u.test(navigator.userAgent)) return "My iPhone";
  if (/Mac/u.test(navigator.platform)) return "My Mac";
  return "My Apple device";
}

function signOut() {
  if (busy) return;
  clearSignIn();
  workflow = null;
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null;
  element("download-link").removeAttribute("href");
  element("download-link").removeAttribute("download");
  element("setup-form").reset();
  element("account-email").textContent = "";
  element("ready-email").textContent = "";
  element("account-avatar").textContent = "";
  element("setup-form").hidden = true;
  element("done-panel").hidden = true;
  element("signin-panel").hidden = false;
  element("card-title").textContent = "A good connection.";
  element("card-description").textContent = "Sign in to create your personal setup profile.";
  setStep("step-signin");
  clearError();
  element("signin-button").focus();
}

element("signin-button").addEventListener("click", async () => {
  if (busy) return;
  clearError();
  setBusy(true, "Connecting to your sign-in provider…");
  try {
    location.assign(await startSignIn(baseURL.href));
  } catch (error) {
    setBusy(false);
    showError(error);
  }
});

for (const id of ["signout-button", "done-signout-button"]) element(id).addEventListener("click", signOut);

element("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !workflow) return;
  clearError();
  setBusy(true, "Creating your device password and preparing the profile…");
  try {
    const result = await workflow.generate({
      name: element("display-name").value,
      deviceName: element("device-name").value,
    });
    if (!downloadURL) {
      downloadURL = URL.createObjectURL(new Blob([result.xml], { type: "application/x-apple-aspen-config" }));
    }
    const link = element("download-link");
    link.href = downloadURL;
    link.download = result.filename;
    element("ready-email").textContent = workflow.context.email;
    element("setup-form").hidden = true;
    element("done-panel").hidden = false;
    element("card-title").textContent = "Ready for your device.";
    element("card-description").textContent = "Your account settings and device password are all filled in.";
    setStep("step-install");
    setBusy(false);
    // The visible link remains available if Safari requires a second user gesture.
    link.click();
    link.focus();
  } catch (error) {
    setBusy(false);
    if (error instanceof HTTPError && error.status === 401) signOut();
    showError(error);
    if (error instanceof CreationUncertainError) element("generate-button").disabled = true;
  }
});

window.addEventListener("pagehide", () => {
  // Do not leave a live token or a credential-bearing file in the back/forward cache.
  workflow = null;
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    setBusy(false);
    signOut();
  }
});

async function boot() {
  if (location.protocol !== "https:") {
    element("signin-button").disabled = true;
    showError(new Error("Open this app over HTTPS on your Stalwart server to sign in."));
    return;
  }
  if (!isCallback(location.href)) return;
  const callbackURL = location.href;
  history.replaceState(null, "", baseURL.pathname);
  setBusy(true, "Signing you in and checking your account settings…");
  try {
    const accessToken = await finishSignIn(callbackURL, baseURL.href);
    const [context, configuration] = await Promise.all([
      loadAccount(baseURL.origin, accessToken),
      discoverConfiguration(baseURL.origin),
    ]);
    // Catch unsupported providers and malformed settings before showing Download.
    profileXML(await makeProfile(context.email, configuration, { name: context.name }));
    workflow = new ProfileDownload(context, configuration);
    element("account-email").textContent = context.email;
    element("account-avatar").textContent = context.email[0];
    element("display-name").value = context.name;
    element("device-name").value = deviceName();
    element("signin-panel").hidden = true;
    element("setup-form").hidden = false;
    element("card-title").textContent = "Let’s connect your account.";
    element("card-description").textContent = "Everything is ready. Download your profile to finish setup.";
    setStep("step-download");
    setBusy(false);
    element("generate-button").focus();
  } catch (error) {
    setBusy(false);
    showError(error);
  }
}

boot();
