import { importInstalledBundle } from "./bundle.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Installer publishes immutable bundle directories and host package symlinks.
import {
  PluginInstallRecord,
  PluginCapability,
  PluginManifest,
  PluginOperationError,
} from "@t3tools/contracts";
import { PLUGIN_API_VERSION } from "@t3tools/plugin-api";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { readGithub, readArchive, type Bundle } from "./installSources.ts";
import { ServerConfig } from "../config.ts";
import {
  BUILTIN_DEPLOY_PROVIDER_IDS,
  BUILTIN_DEPLOY_SECRET_PREFIX,
} from "../deploy/BuiltinDeployProviders.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { PluginHost } from "./PluginHost.ts";
import { isValidPluginId, isValidVersionSegment } from "./installedPaths.ts";
import { readInstallRecord, writeInstallRecord } from "./installRecords.ts";

const decodeManifest = Schema.decodeSync(Schema.fromJsonString(PluginManifest));

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/** What a shop entry promised before the host downloaded its bundle. */
export interface BundleExpectation {
  readonly id?: string;
  readonly version?: string;
  readonly capabilities?: ReadonlyArray<PluginCapability>;
  /** The API version the shop declared; absent means it did not declare one. */
  readonly apiVersion?: number;
}

export interface InstallerOptions {
  readonly github?: (source: string) => Promise<Bundle>;
  readonly hostPackages?: Readonly<Record<string, string>>;
}

export const hostPackagePaths = (): Readonly<Record<string, string>> => {
  const require = NodeModule.createRequire(import.meta.url);
  const names = [
    "effect",
    "@t3tools/plugin-api",
    "@t3tools/contracts",
    "@effect/platform-node",
    "@effect/platform-node-shared",
  ];
  return Object.fromEntries(
    names.map((name) => {
      let dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve(name)));
      while (dir !== NodePath.dirname(dir)) {
        try {
          const metadata: unknown = require(NodePath.join(dir, "package.json"));
          if (
            typeof metadata === "object" &&
            metadata !== null &&
            "name" in metadata &&
            metadata.name === name
          )
            return [name, dir];
        } catch {}
        dir = NodePath.dirname(dir);
      }
      throw new Error(`Cannot resolve host external ${name}.`);
    }),
  );
};

export const linkHostPackages = async (dir: string, packages: Readonly<Record<string, string>>) => {
  for (const [name, target] of Object.entries(packages)) {
    const destination = NodePath.join(dir, "node_modules", name);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.symlink(target, destination, "junction");
  }
};

export const makeInstaller = Effect.fn("PluginInstaller.make")(function* (
  options: InstallerOptions = {},
) {
  const { stateDir } = yield* ServerConfig;
  const host = yield* PluginHost;
  const secrets = yield* ServerSecretStore;
  const bundledIds = new Set([
    ...(yield* host.snapshot).plugins
      .filter((plugin) => plugin.origin === "bundled")
      .map((plugin) => plugin.manifest.id),
    ...BUILTIN_DEPLOY_PROVIDER_IDS,
  ]);
  const lock = yield* Semaphore.make(1);
  const root = NodePath.join(stateDir, "installed-plugins");
  const io = <A>(id: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) =>
        new PluginOperationError({
          pluginId: id,
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  const record = async (id: string) => {
    if (!isValidPluginId(id)) throw new Error("Invalid plugin id.");
    if (bundledIds.has(id))
      throw new Error("This plugin is built into this version of the server.");
    const value = await readInstallRecord(stateDir, id);
    if (!value || value.id !== id) throw new Error("Plugin is not installed.");
    return value;
  };
  const manifestFor = async (id: string, version: string) => {
    const manifest = decodeManifest(
      await NodeFSP.readFile(NodePath.join(root, id, version, "manifest.json"), "utf8"),
    );
    if (
      manifest.id !== id ||
      manifest.version !== version ||
      (manifest.apiVersion !== undefined && manifest.apiVersion !== PLUGIN_API_VERSION)
    )
      throw new Error("Installed manifest identity or API version mismatch.");
    return manifest;
  };
  const list = Effect.gen(function* () {
    const snapshot = yield* host.snapshot;
    const installations = yield* io("", async () => {
      const ids = await NodeFSP.readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const records: PluginInstallRecord[] = [];
      for (const id of ids.filter(isValidPluginId)) {
        const value = await readInstallRecord(stateDir, id);
        if (value) records.push(value);
      }
      return records;
    });
    const stagedManifests = yield* io("", () =>
      Promise.all(
        installations
          .filter((item) => item.stagedVersion !== null)
          .map((item) => manifestFor(item.id, item.stagedVersion!)),
      ),
    );
    return { snapshot, installations, stagedManifests };
  });
  const accept = Effect.fn("PluginInstaller.accept")(function* (
    bundle: Bundle,
    origin: PluginInstallRecord["versions"][number]["source"],
    expected: BundleExpectation = {},
  ) {
    const installedAt = DateTime.formatIso(yield* DateTime.now);
    const snapshot = yield* host.snapshot;
    return yield* io(expected.id ?? "", async () => {
      let manifest: PluginManifest;
      try {
        manifest = decodeManifest(bundle.manifest);
      } catch {
        throw new Error(
          "No valid manifest.json. Choose a prebuilt plugin bundle with a compatible manifest.",
        );
      }
      if (!isValidVersionSegment(manifest.version)) throw new Error("Invalid plugin version.");
      if (expected.id && manifest.id !== expected.id)
        throw new Error("The shop entry id does not match the manifest it downloads.");
      if (expected.version && manifest.version !== expected.version)
        throw new Error("The shop entry version does not match the manifest it downloads.");
      if (expected.capabilities && !sameSet(manifest.capabilities, expected.capabilities))
        throw new Error("The shop entry capabilities do not match the manifest it downloads.");
      if (
        expected.apiVersion !== undefined &&
        (manifest.apiVersion ?? PLUGIN_API_VERSION) !== expected.apiVersion
      )
        throw new Error("The shop entry API version does not match the manifest it downloads.");
      if (
        bundledIds.has(manifest.id) ||
        snapshot.plugins.some(
          (plugin) => plugin.manifest.id === manifest.id && plugin.origin === "bundled",
        )
      )
        throw new Error("This plugin is built into this version of the server.");
      if (manifest.apiVersion !== undefined && manifest.apiVersion !== PLUGIN_API_VERSION)
        throw new Error("Incompatible plugin API. Update p0code or the plugin.");
      const bundleSha256 = NodeCrypto.createHash("sha256").update(bundle.code).digest("hex");
      const old = await readInstallRecord(stateDir, manifest.id);
      if (old && old.id !== manifest.id) throw new Error("Install record id mismatch.");
      if (old?.versions.some((version) => version.version === manifest.version))
        throw new Error("This version is already installed. Install a new version instead.");
      const parent = NodePath.join(root, manifest.id);
      await NodeFSP.mkdir(parent, { recursive: true });
      const temporary = NodePath.join(parent, `.stage-${NodeCrypto.randomUUID()}`);
      await NodeFSP.mkdir(temporary);
      try {
        await NodeFSP.writeFile(
          NodePath.join(temporary, "manifest.json"),
          JSON.stringify(manifest),
        );
        await NodeFSP.writeFile(NodePath.join(temporary, "plugin.mjs"), bundle.code);
        await linkHostPackages(temporary, options.hostPackages ?? hostPackagePaths());
        await NodeFSP.rename(temporary, NodePath.join(parent, manifest.version));
      } finally {
        await NodeFSP.rm(temporary, { recursive: true, force: true });
      }
      const next: PluginInstallRecord = {
        id: manifest.id,
        activeVersion: old?.activeVersion ?? null,
        previousVersion: old?.previousVersion ?? null,
        versions: [
          ...(old?.versions ?? []),
          {
            version: manifest.version,
            source: origin,
            installedAt,
            bundleSha256,
            consentedCapabilities: [],
            consented: false,
          },
        ],
        stagedVersion: manifest.version,
        removedDataAt: old?.removedDataAt ?? null,
      };
      await writeInstallRecord(stateDir, next);
      return { record: next, manifest, restartRequired: false };
    });
  });
  const resolve = (source: string, upload?: { readonly name: string; readonly data: string }) =>
    io("", async () => {
      let bundle: Bundle;
      let origin: PluginInstallRecord["versions"][number]["source"];
      const local = await NodeFSP.stat(source).then(
        (stat) => stat.isDirectory(),
        () => false,
      );
      if (upload) {
        bundle = await readArchive(Buffer.from(upload.data, "base64"), upload.name);
        origin = { kind: "local", path: "" };
      } else if (
        !local &&
        /^(https?:|[\w.-]+\/[\w.-]+(?:@.*)?$)/.test(source) &&
        !NodePath.isAbsolute(source)
      ) {
        bundle = await (options.github ?? readGithub)(source);
        origin = { kind: "github", url: source };
      } else if (local) {
        const dir = NodePath.resolve(source);
        try {
          bundle = {
            manifest: await NodeFSP.readFile(NodePath.join(dir, "manifest.json"), "utf8"),
            code: await NodeFSP.readFile(NodePath.join(dir, "plugin.mjs")),
          };
        } catch {
          throw new Error("No manifest.json + plugin.mjs bundle. Choose a prebuilt plugin folder.");
        }
        origin = { kind: "local", path: dir };
      } else if (/\.(zip|tgz|tar\.gz)$/.test(source) && NodePath.isAbsolute(source)) {
        bundle = await readArchive(await NodeFSP.readFile(source), source);
        origin = { kind: "local", path: source };
      } else {
        throw new Error(
          "No plugin bundle at this path. Choose a folder, archive, GitHub URL, or shop entry.",
        );
      }
      return { bundle, origin };
    });
  const stage = Effect.fn("PluginInstaller.stage")(function* (
    source: string,
    expectedId?: string,
    upload?: { readonly name: string; readonly data: string },
  ) {
    const resolved = yield* resolve(source, upload);
    return yield* accept(resolved.bundle, resolved.origin, expectedId ? { id: expectedId } : {});
  });
  const installBundle = Effect.fn("PluginInstaller.installBundle")(function* (input: {
    readonly bundle: Bundle;
    readonly origin: PluginInstallRecord["versions"][number]["source"];
    readonly expected: BundleExpectation;
  }) {
    return yield* accept(input.bundle, input.origin, input.expected);
  });
  const activate = Effect.fn("PluginInstaller.activate")(function* (
    next: PluginInstallRecord,
    manifest: PluginManifest,
  ) {
    const installed = next.versions.find((version) => version.version === manifest.version);
    const plugin = yield* io(next.id, () =>
      importInstalledBundle(
        NodePath.join(root, next.id, manifest.version),
        manifest,
        installed?.bundleSha256,
      ),
    );
    yield* io(next.id, () => writeInstallRecord(stateDir, next));
    yield* host.replace(next.id, plugin);
    return { record: next, manifest, restartRequired: false };
  });
  return {
    list,
    install: (input: {
      readonly source: string;
      readonly upload?: { readonly name: string; readonly data: string };
    }) => lock.withPermits(1)(stage(input.source, undefined, input.upload)),
    installBundle: (input: {
      readonly bundle: Bundle;
      readonly origin: PluginInstallRecord["versions"][number]["source"];
      readonly expected: BundleExpectation;
    }) => lock.withPermits(1)(installBundle(input)),
    update: (input: {
      readonly id: string;
      readonly source?: string;
      readonly upload?: { readonly name: string; readonly data: string };
    }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const old = yield* io(input.id, () => record(input.id));
          const last = old.versions.at(-1)?.source;
          if (!input.source && !input.upload && last?.kind === "catalog")
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "Update this plugin from the Shop tab.",
            });
          const source =
            input.source ??
            (last?.kind === "local" ? last.path : last?.kind === "github" ? last.url : undefined);
          if (!source && !input.upload)
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "Provide an update source.",
            });
          return yield* stage(source ?? "", input.id, input.upload);
        }),
      ),
    consent: (input: {
      readonly id: string;
      readonly version: string;
      readonly capabilities: ReadonlyArray<PluginCapability>;
    }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const old = yield* io(input.id, () => record(input.id));
          if (old.stagedVersion !== input.version)
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "This version is not staged.",
            });
          const manifest = yield* io(input.id, () => manifestFor(input.id, input.version));
          if (!sameSet(input.capabilities, manifest.capabilities))
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "Consent must match all declared capabilities.",
            });
          return yield* activate(
            {
              ...old,
              activeVersion: input.version,
              previousVersion: old.activeVersion,
              stagedVersion: null,
              versions: old.versions.map((version) =>
                version.version === input.version
                  ? { ...version, consented: true, consentedCapabilities: input.capabilities }
                  : version,
              ),
            },
            manifest,
          );
        }),
      ),
    rollback: (input: { readonly id: string }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const old = yield* io(input.id, () => record(input.id));
          const previous = old.versions.find((version) => version.version === old.previousVersion);
          if (!previous?.consented)
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "No consented previous version to restore.",
            });
          const manifest = yield* io(input.id, () => manifestFor(input.id, previous.version));
          if (
            !manifest.capabilities.every((capability) =>
              previous.consentedCapabilities.includes(capability),
            )
          )
            return yield* new PluginOperationError({
              pluginId: input.id,
              message: "Previous version needs consent.",
            });
          return yield* activate(
            {
              ...old,
              activeVersion: previous.version,
              previousVersion: old.activeVersion,
              stagedVersion: null,
            },
            manifest,
          );
        }),
      ),
    remove: (input: { readonly id: string; readonly purgeData: boolean }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const old = yield* io(input.id, () => record(input.id));
          yield* host.replace(input.id, null);
          if (input.purgeData) {
            if (!secrets.list)
              return yield* new PluginOperationError({
                pluginId: input.id,
                message: "Secret store cannot enumerate secrets for purge.",
              });
            const names = (yield* secrets
              .list(`plugin-${input.id}-`)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new PluginOperationError({ pluginId: input.id, message: error.message }),
                ),
              )).filter((name) => !name.startsWith(BUILTIN_DEPLOY_SECRET_PREFIX));
            yield* Effect.forEach(names, (name) => secrets.remove(name), { discard: true }).pipe(
              Effect.mapError(
                (error) => new PluginOperationError({ pluginId: input.id, message: error.message }),
              ),
            );
            yield* secrets
              .remove(`plugin-route-secret-${input.id}`)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new PluginOperationError({ pluginId: input.id, message: error.message }),
                ),
              );
          }
          const next: PluginInstallRecord = {
            ...old,
            activeVersion: null,
            previousVersion: null,
            stagedVersion: null,
            versions: [],
            removedDataAt: input.purgeData
              ? DateTime.formatIso(yield* DateTime.now)
              : old.removedDataAt,
          };
          yield* io(input.id, async () => {
            if (input.purgeData)
              await NodeFSP.rm(NodePath.join(stateDir, "plugins", input.id), {
                recursive: true,
                force: true,
              });
            for (const version of old.versions)
              await NodeFSP.rm(NodePath.join(root, input.id, version.version), {
                recursive: true,
                force: true,
              });
            await writeInstallRecord(stateDir, next);
          });
          return { record: next, manifest: null, restartRequired: false };
        }),
      ),
  };
});

export class PluginInstaller extends Context.Service<
  PluginInstaller,
  Effect.Success<ReturnType<typeof makeInstaller>>
>()("p0/plugins/installer/PluginInstaller") {}
export const layer = Layer.effect(PluginInstaller, makeInstaller());
