// @effect-diagnostics nodeBuiltinImport:off -- The keychain binding is a native module loaded on demand.
import * as NodeModule from "node:module";
import { APP_HOME_DIRECTORY_NAME, STOCK_T3_HOME_DIRECTORY_NAME } from "@t3tools/shared/appHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  credentialNamespace,
  keychainSecrets,
  keyringStore,
  type KeychainStore,
} from "@t3tools/shared/credentialKeychain";
import { migrateFromT3, shouldOfferT3Import } from "@t3tools/shared/migrateFromT3";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { msg } from "gt-i18n";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const requireExternal = NodeModule.createRequire(import.meta.url);

const tryLoadKeychain = async (
  secretsDir: string,
  platform: NodeJS.Platform,
): Promise<KeychainStore | null> => {
  if (process.env.HHHCODE_SECRET_BACKEND?.trim().toLowerCase() === "file" || process.env.VITEST) {
    return null;
  }
  try {
    const keyring: typeof import("@napi-rs/keyring") = requireExternal("@napi-rs/keyring");
    const store = keyringStore(keyring, platform);
    await keychainSecrets(store, await credentialNamespace(secretsDir)).probe();
    return store;
  } catch {
    return null;
  }
};

/**
 * On the first launch of a default `~/.hhh` home next to a stock T3 Code install,
 * asks once whether to import it. Returns true when the app is relaunching.
 */
export const offerT3Import = Effect.fn("desktop.offerT3Import")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  const defaultHome = path.join(environment.homeDirectory, APP_HOME_DIRECTORY_NAME);
  if (environment.isDevelopment || environment.baseDir !== defaultHome) return false;
  const stockHome = path.join(environment.homeDirectory, STOCK_T3_HOME_DIRECTORY_NAME);
  const offer = yield* Effect.promise(() =>
    shouldOfferT3Import({ appHome: environment.baseDir, stockHome }),
  );
  if (!offer) return false;

  const dialog = yield* ElectronDialog.ElectronDialog;
  const { response } = yield* dialog.showMessageBox({
    type: "question",
    title: m(msg("Import from T3 Code")),
    message: m(msg("Bring your T3 Code threads, settings and providers over?")),
    detail: m(
      msg(
        "hhhcode keeps its data in {home}, separate from T3 Code in {stock}. Importing copies everything you need and never changes T3 Code's data. You can also do this later with `t3 migrate from-t3`.",
      ),
      { home: environment.baseDir, stock: stockHome },
    ),
    buttons: [
      m(msg("Import", { $context: "button, imports data from T3 Code" })),
      m(msg("Start fresh", { $context: "button, starts without importing" })),
    ],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;

  const platform = yield* HostProcess.Platform;
  const failure = yield* Effect.tryPromise({
    // The desktop has already written its own startup files here; they are moved aside.
    try: async () => {
      const keychain = await tryLoadKeychain(
        path.join(environment.baseDir, "userdata", "secrets"),
        platform,
      );
      return migrateFromT3({ from: stockHome, to: environment.baseDir, force: true, keychain });
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(Effect.match({ onFailure: (reason) => reason, onSuccess: () => undefined }));
  if (failure !== undefined) {
    yield* dialog.showErrorBox(
      m(msg("Could not import from T3 Code")),
      m(
        msg(
          "{reason} Quit hhhcode and run `t3 migrate from-t3 --force` in a terminal to try again.",
        ),
        { reason: failure },
      ),
    );
    return false;
  }
  const electronApp = yield* ElectronApp.ElectronApp;
  // Settings already loaded in this process belong to the empty home; start over from the import.
  yield* electronApp.relaunch({});
  yield* electronApp.quit;
  return true;
});
