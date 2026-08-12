export interface InstallationIdentity {
  installationId: string;
  installationToken: string;
}

export interface InstallationIdentityStore {
  loadOrCreate(): Promise<InstallationIdentity>;
}

const STORAGE_KEY = "veeky.installationIdentity.v1";

function createInstallationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isInstallationIdentity(value: unknown): value is InstallationIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InstallationIdentity>;
  return typeof candidate.installationId === "string"
    && typeof candidate.installationToken === "string"
    && candidate.installationId.length > 0
    && candidate.installationToken.length >= 43;
}

export const browserInstallationIdentityStore: InstallationIdentityStore = {
  async loadOrCreate() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const current = stored[STORAGE_KEY];
    if (isInstallationIdentity(current)) return current;

    const identity = {
      installationId: crypto.randomUUID(),
      installationToken: createInstallationToken(),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: identity });
    return identity;
  },
};
