/**
 * String helpers from Unreal.Core/Extensions/StringExtensions.cs.
 */

/** see UObjectBaseUtility — strip everything up to the last '.', stop at '/'. */
export function removeAllPathPrefixes(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i];
    if (c === ".") return path.slice(i + 1);
    if (c === "/") return path;
  }
  return removePathPrefix(path, "Default__");
}

export function removePathPrefix(path: string, toRemove: string): string {
  if (toRemove.length > path.length) return path;
  for (let i = 0; i < toRemove.length; i++) {
    if (path[i] !== toRemove[i]) return path;
  }
  return path.slice(toRemove.length);
}

/** Strip trailing digits and underscores. */
export function cleanPathSuffix(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i]!;
    if (!(c >= "0" && c <= "9") && c !== "_") {
      return path.slice(0, i + 1);
    }
  }
  return path;
}
