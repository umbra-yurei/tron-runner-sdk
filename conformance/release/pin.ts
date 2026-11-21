// The Tron the release run proves the SDKs against. The pin is three commits (Tron and the two sibling repositories its
// Cargo path-dependencies live in), because Tron's own lockfile cannot pin a path dependency. Move it to the Tron the
// release targets, and say so in the commit: this is the Tron that ships today, so an SDK that works here works in production.
export interface Revision {
  /** Environment variable naming a checkout of the repository; the directory defaults to `directory` next to this repository. */
  directoryVariable: string;
  directory: string;
  /** Full commit hash. */
  commit: string;
}

export interface TronPin {
  /** Human-readable name of what `tron.commit` is, for the log. */
  describes: string;
  tron: Revision;
  umbraAuth: Revision;
  crumaWebApi: Revision;
}

export const TRON_PIN: TronPin = {
  describes: "Tron v0.1.13, the version live in production on 2026-11-21",
  tron: { directoryVariable: "TRON_DIR", directory: "../tron", commit: "b6acff3ca5c0f918ff7c07d78869039373dc7617" },
  umbraAuth: { directoryVariable: "UMBRA_AUTH_DIR", directory: "../umbra-auth", commit: "1a193a238a3613892eb814d3e2caa39b0eaf2b0d" },
  crumaWebApi: { directoryVariable: "CRUMA_WEB_API_DIR", directory: "../cruma-web-api", commit: "a7554701e0fd8cb4dc23f985098b32ed35e4fbd3" },
};

export const POSTGRES_IMAGE = "docker.io/library/postgres:17-alpine";
