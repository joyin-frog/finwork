import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.join(process.cwd(), "app");
const NATIVE_FORM_CONTROL_RE = /<(input|textarea|select)\b/g;

function listTsxFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolutePath = path.join(directory, entry);
    const relativePath = path.relative(APP_DIR, absolutePath);

    if (relativePath === "dev" || relativePath.startsWith(`dev${path.sep}`)) {
      return [];
    }

    if (statSync(absolutePath).isDirectory()) {
      return listTsxFiles(absolutePath);
    }

    return entry.endsWith(".tsx") ? [absolutePath] : [];
  });
}

export const shadcnNativeControlsTestPromise = (async () => {
  const violations = listTsxFiles(APP_DIR).flatMap((file) => {
    const source = readFileSync(file, "utf8");

    return [...source.matchAll(NATIVE_FORM_CONTROL_RE)].map((match) => ({
      file: path.relative(process.cwd(), file),
      line: source.slice(0, match.index).split("\n").length,
      tag: match[1],
    }));
  });

  assert.equal(
    violations.length,
    0,
    `Production UI must use shadcn form controls instead of raw HTML tags:\n${violations
      .map(({ file, line, tag }) => `  ${file}:${line} <${tag}>`)
      .join("\n")}`
  );

  console.log("shadcn-native-controls: no raw production form controls ✓");
})();
