// Run with `node --test scripts/fork-compose.test.mjs`; needs Docker Compose,
// but never starts containers or reads a local .env file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL("../", import.meta.url));
function config(overrides = {}, migrate = false) {
  const files = ["-f", "compose.yaml"];
  if (migrate) files.push("-f", "compose.migrate.yaml");
  return spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      "openseo-auth-test",
      ...files,
      "config",
      "--format",
      "json",
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        STORAGE_ACCESS_KEY: "test-access",
        STORAGE_SECRET_KEY: "test-only-not-a-deployment-secret",
        BETTER_AUTH_URL: "https://openseo.enesbala.com",
        ...overrides,
      },
    },
  );
}
function parsed(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test("public deployment uses a pinned standalone image and password auth despite stale Coolify env", () => {
  const { services } = parsed(
    config({
      AUTH_MODE: "local_noauth",
      OPEN_SEO_IMAGE: "ghcr.io/every-app/open-seo:latest",
    }),
  );
  for (const service of ["runtime", "init", "crawl-gateway"])
    assert.equal(
      services[service].image,
      "ghcr.io/every-app/open-seo-standalone:0.1.27",
    );
  assert.equal(services.init.environment.AUTH_MODE, "password");
  assert.equal(
    services.init.environment.BETTER_AUTH_URL,
    "https://openseo.enesbala.com",
  );
});

test("deployment refuses missing storage credentials or public origin", () => {
  for (const key of [
    "STORAGE_ACCESS_KEY",
    "STORAGE_SECRET_KEY",
    "BETTER_AUTH_URL",
  ]) {
    const result = config({ [key]: "" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(key), result.stderr);
  }
});

test("only the web proxy publishes a loopback port; state and generated secrets persist", () => {
  const { services, volumes } = parsed(config());
  assert.deepEqual(
    Object.keys(services).filter((name) => services[name].ports?.length),
    ["web"],
  );
  assert.equal(services.web.ports[0].host_ip, "127.0.0.1");
  assert.equal(services.web.ports[0].target, 80);
  assert.equal(
    services.web.depends_on.init.condition,
    "service_completed_successfully",
  );
  assert.equal(
    services.runtime.volumes.find((volume) => volume.target === "/config")
      .read_only,
    true,
  );
  for (const name of ["storage", "config", "runtime", "web-config"])
    assert.ok(volumes[name]);
});

test("migration reads the original volume without modifying it and blocks web until success", () => {
  const { services, volumes } = parsed(
    config({ LEGACY_VOLUME: "existing-coolify-volume" }, true),
  );
  assert.equal(volumes.legacy.name, "existing-coolify-volume");
  assert.equal(volumes.legacy.external, true);
  const legacy = services.migrate.volumes.find(
    (volume) => volume.target === "/legacy",
  );
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.read_only, true);
  assert.equal(services.migrate.build.context, cwd.replace(/\/$/, ""));
  assert.equal(services.migrate.build.target, "build");
  assert.equal(services.migrate.network_mode, "service:runtime");
  assert.equal(
    services.migrate.depends_on.init.condition,
    "service_completed_successfully",
  );
  assert.equal(
    services.web.depends_on.migrate.condition,
    "service_completed_successfully",
  );
  assert.notEqual(
    config({}, true).status,
    0,
    "migration must require an explicit legacy volume",
  );
});
