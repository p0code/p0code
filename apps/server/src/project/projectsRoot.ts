import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Path from "effect/Path";

/** Named projects live here until someone picks another folder in settings. */
export const defaultProjectsRoot = (baseDir: string, path: Path.Path): string =>
  path.resolve(baseDir, "projects");

/** Null when the saved value is not an absolute folder on this host. */
export function resolveProjectsRoot(
  setting: string | null,
  baseDir: string,
  path: Path.Path,
  home: string,
): string | null {
  const value = setting?.trim() ?? "";
  if (value === "") return defaultProjectsRoot(baseDir, path);
  const expanded = expandHomePath(value, home);
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

/** True when `target` is `directory` or sits inside it. */
export function isInsideDirectory(directory: string, target: string, path: Path.Path): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
