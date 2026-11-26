// @effect-diagnostics nodeBuiltinImport:off -- Install records use atomic rename next to version directories.
import { PluginInstallRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const decodeRecord = Schema.decodeSync(Schema.fromJsonString(PluginInstallRecord));
const validateRecord = Schema.decodeSync(PluginInstallRecord);

const recordPath = (stateDir: string, id: string) =>
  NodePath.join(stateDir, "installed-plugins", id, "installed.json");
export const readInstallRecord = async (stateDir: string, id: string) => {
  try {
    return decodeRecord(await NodeFSP.readFile(recordPath(stateDir, id), "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
};
export const writeInstallRecord = async (stateDir: string, record: PluginInstallRecord) => {
  const file = recordPath(stateDir, record.id);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(validateRecord(record)), {
      flag: "wx",
      mode: 0o600,
    });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};
