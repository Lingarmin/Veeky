export interface BuildDeployment {
  target: "local" | "release";
  apiOrigin: "";
  outDir: string;
}

/** Standalone builds ignore former backend environment settings. */
export function resolveBuildDeployment(mode: string, _env: Record<string, string | undefined> = {}): BuildDeployment {
  return { target: mode === "release" ? "release" : "local", apiOrigin: "", outDir: mode === "release" ? "dist-release" : "dist" };
}

export function createExtensionManifest<T extends { host_permissions: string[] }>(manifest: T, _config: BuildDeployment): T {
  return {
    ...manifest,
    host_permissions: manifest.host_permissions.filter((entry) => entry.startsWith("https:")),
  };
}
