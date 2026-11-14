import { createAppPassword, CreationUncertainError } from "./api.js";
import { makeProfile, profileXML, withPassword } from "./profile.js";

export class ProfileDownload {
  constructor(context, document, fetcher = fetch) {
    this.context = context;
    this.document = document;
    this.fetcher = fetcher;
    this.result = null;
    this.credential = null;
    this.template = null;
    this.inFlight = null;
    this.uncertain = false;
  }

  generate({ name = "", deviceName = "Apple device" } = {}) {
    if (this.result) return Promise.resolve(this.result);
    if (this.inFlight) return this.inFlight;
    if (this.uncertain) {
      return Promise.reject(new CreationUncertainError("Check your app passwords in Stalwart before starting again."));
    }
    this.inFlight = this.prepare(name, deviceName).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async prepare(name, deviceName) {
    if (!this.template) {
      const template = await makeProfile(this.context.email, this.document, { name });
      // Validate serialization before making any credential-changing request.
      profileXML(template);
      this.template = template;
    }
    if (!this.credential) {
      const label = `Apple Mail & Calendar — ${deviceName.trim() || "Apple device"} — ${new Date().toISOString()}`;
      try {
        this.credential = await createAppPassword(this.context, label, this.fetcher);
      } catch (error) {
        if (error instanceof CreationUncertainError) this.uncertain = true;
        this.template = null;
        throw error;
      }
    }
    const xml = profileXML(withPassword(this.template, this.credential.secret));
    this.result = {
      xml,
      filename: `${this.context.email.replace(/[^a-zA-Z0-9@._-]/gu, "_")}.mobileconfig`,
    };
    return this.result;
  }
}
