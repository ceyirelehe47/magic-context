import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import {
  LATEST_SUPPORTED_VERSION,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import {
  classifyDatabaseOpen,
  listProfiles,
  profileBundleFacts,
  runDshDoctor,
  scanLivenessMarkers,
} from "./doctor";
import { runDshSetup } from "./setup";
import { DSH_COMPAT_EXPECTED_VERSION, MAGIC_CONTEXT_PACKAGE } from "./env";
import { fakeDshInstall, fakeDshProfile } from "./fake-dsh";
import { MANAGED_BEGIN } from "../compat/dsh-0.1/profile-patch";

/** Fake 0.2 dsh install (hoisted @deepseek-ai tree); returns the dsh package dir. */
function fakeInstall(root: string, version = DSH_COMPAT_EXPECTED_VERSION): string {
  return fakeDshInstall(root, { version });
}

function fakeProfile(dshHome: string, name: string, bundles: string[]): void {
  fakeDshProfile(dshHome, name, bundles);
}

interface TestEnv {
  root: string;
  dshHome: string;
  installDir: string;
  configHome: string;
  work: string;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-doctor-"));
  return {
    root,
    dshHome: join(root, "dsh-home"),
    installDir: join(root, "install"),
    configHome: join(root, "config"),
    work: join(root, "work"),
  };
}

async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function byId(report: Awaited<ReturnType<typeof runDshDoctor>>): Map<string, Awaited<ReturnType<typeof runDshDoctor>>["checks"][number]> {
  return new Map(report.checks.map((check) => [check.id, check]));
}

describe("dsh-magic-context doctor (Phase 2 slice C)", () => {
  it("classifies a healthy shared DB open as ok", async () => {
    const env = makeEnv();
    try {
      const dbPath = join(env.root, "ok", "context.db");
      const outcome = await classifyDatabaseOpen(dbPath);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.schemaVersion).toBe(LATEST_SUPPORTED_VERSION);
        expect(outcome.latestSupported).toBe(LATEST_SUPPORTED_VERSION);
        outcome.db?.close();
      }
    } finally {
      await cleanup(env.root);
    }
  });

  it("classifies a newer persisted schema as a schema-fence refusal", async () => {
    const env = makeEnv();
    try {
      const dbPath = join(env.root, "fence", "context.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec("CREATE TABLE schema_migrations (version INTEGER NOT NULL)");
      db.exec("INSERT INTO schema_migrations (version) VALUES (9999)");
      db.close();
      const outcome = await classifyDatabaseOpen(dbPath);
      expect(outcome.kind).toBe("schema-fence");
    } finally {
      await cleanup(env.root);
    }
  });

  it("scans liveness markers: own pid is live, an impossible pid is stale", async () => {
    const env = makeEnv();
    try {
      const storage = join(env.root, "storage");
      const dir = join(storage, "rpc", "a1b2c3d4");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `port-${process.pid}.json`),
        JSON.stringify({ port: 1, pid: process.pid, started_at: Date.now() }),
      );
      writeFileSync(
        join(dir, "port-99999999.json"),
        JSON.stringify({ port: 2, pid: 99999999, started_at: Date.now() }),
      );
      const scan = scanLivenessMarkers(storage);
      expect(scan.liveCount).toBe(1);
      expect(scan.markers.find((marker) => marker.pid === process.pid)?.live).toBe(true);
      expect(scan.markers.find((marker) => marker.pid === 99999999)?.live).toBe(false);
    } finally {
      await cleanup(env.root);
    }
  });

  it("reads profile bundle facts from a fake profile", async () => {
    const env = makeEnv();
    try {
      fakeProfile(env.dshHome, "web", ["@deepseek-ai/dsh-base", MAGIC_CONTEXT_PACKAGE]);
      fakeProfile(env.dshHome, "headless", ["@deepseek-ai/dsh-base"]);
      expect(listProfiles(env.dshHome).sort()).toEqual(["headless", "web"]);
      const web = profileBundleFacts(env.dshHome, "web");
      expect(web.bundleInstalled).toBe(true);
      expect(web.nodeModulesPackageExists).toBe(true);
      const headless = profileBundleFacts(env.dshHome, "headless");
      expect(headless.bundleInstalled).toBe(false);
    } finally {
      await cleanup(env.root);
    }
  });

  it("reports ok across the full checklist on a clean environment", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"));
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const setup = await runDshSetup(["--profile", "web"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(setup.exitCode).toBe(0);
      {
        // Pre-create the shared DB so the shared-db check classifies ok. The
        // core caches handles by path: keep this handle open (do NOT close it)
        // or the doctor's reopen would see a closed cached handle; the doctor
        // itself closes the handle after classifying.
        const dbPath = join(env.root, "storage", "context.db");
        const pre = await openDatabaseAsync({ dbPath });
        expect(pre).not.toBeNull();

        const report = await runDshDoctor([], {
          dshHome: env.dshHome,
          dshInstallDir: env.installDir,
          directory: env.work,
          storageDirOverride: join(env.root, "storage"),
          dbPathOverride: dbPath,
        });
        expect(report.exitCode).toBe(0);
        const checks = byId(report);
        expect(checks.get("dsh-version")?.status).toBe("ok");
        expect(checks.get("bundle-install.web")?.status).toBe("ok");
        expect(checks.get("profile-wiring.web")?.status).toBe("ok");
        expect(checks.get("shared-db")?.status).toBe("ok");
        expect(checks.get("liveness-markers")?.status).toBe("ok");
        expect(checks.get("config-load")?.status).toBe("ok");
      }
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("accepts DSH 0.2.2-alpha.3 as a declared version (round 29)", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"), "0.2.2-alpha.3");
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
      });
      const version = byId(report).get("dsh-version");
      expect(version?.status).toBe("ok");
      expect(version?.detail).toContain("0.2.2-alpha.3");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("still fails an untested DSH such as 0.2.2-rc.1 (round 29)", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"), "0.2.2-rc.1");
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
      });
      const version = byId(report).get("dsh-version");
      expect(version?.status).toBe("fail");
      expect(version?.detail).toContain("0.2.2-rc.1");
      expect(version?.detail).toContain("0.2.2-alpha.3");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the version check on an exact-rc mismatch", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"), "0.1.0-rc.5");
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
      });
      const version = byId(report).get("dsh-version");
      expect(version?.status).toBe("fail");
      expect(version?.detail).toContain("0.1.0-rc.5");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the bundle check when the package is missing from a profile", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"));
      fakeProfile(env.dshHome, "web", ["@deepseek-ai/dsh-base"]);
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        profile: "web",
      });
      const bundle = byId(report).get("bundle-install.web");
      expect(bundle?.status).toBe("fail");
      expect(bundle?.fix).toContain("dsh plugin");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the profile-wiring check when setup never wrote the Magic rows", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"));
      fakeProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base", MAGIC_CONTEXT_PACKAGE]);
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        profile: "test",
      });
      const wiring = byId(report).get("profile-wiring.test");
      expect(wiring?.status).toBe("fail");
      expect(wiring?.detail).toContain("compaction-basic still active");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the profile-wiring check on a stale managed block", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"));
      fakeProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base"]);
      const setup = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
      });
      expect(setup.exitCode).toBe(0);
      const patchPath = join(env.dshHome, "profiles", "test", "cordis.patch.yml");
      const text = readFileSync(patchPath, "utf8");
      expect(text).toContain(MANAGED_BEGIN);
      writeFileSync(patchPath, text.replace("dsh-magic-context/agent", "dsh-magic-context/agent-old"));
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        profile: "test",
      });
      expect(byId(report).get("profile-wiring.test")?.status).toBe("fail");
      expect(byId(report).get("profile-wiring.test")?.detail).toContain("stale");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the shared-db check on a schema-fence DB", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      env.installDir = fakeInstall(join(env.root, "install"));
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const dbPath = join(env.root, "storage", "context.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec("CREATE TABLE schema_migrations (version INTEGER NOT NULL)");
      db.exec("INSERT INTO schema_migrations (version) VALUES (9999)");
      db.close();
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        storageDirOverride: join(env.root, "storage"),
        dbPathOverride: dbPath,
        profile: "web",
      });
      const sharedDb = byId(report).get("shared-db");
      expect(sharedDb?.status).toBe("fail");
      expect(sharedDb?.detail).toContain("schema fence");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });
});
