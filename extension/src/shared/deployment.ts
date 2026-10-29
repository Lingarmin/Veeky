/// <reference types="vite/client" />

interface Deployment {
  target: "local" | "release";
  apiOrigin: string;
}

// Vite supplies a validated destination for every build. Only unit tests use a
// stub/fallback; that entire branch is removed from production artifacts.
declare const __VEEKY_DEPLOYMENT__: Deployment;
export const DEPLOYMENT: Deployment = import.meta.env.MODE === "test"
  ? (typeof __VEEKY_DEPLOYMENT__ === "undefined"
      ? { target: "local", apiOrigin: "http://127.0.0.1:8000" }
      : __VEEKY_DEPLOYMENT__)
  : __VEEKY_DEPLOYMENT__;
export const IS_RELEASE = DEPLOYMENT.target === "release";
