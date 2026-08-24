import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  getSpreadsheetCapabilities,
  getSpreadsheetFixtureDir,
} from "../lib/runtime/spreadsheet-probe.ts";
import { resolveLibreOffice } from "../lib/runtime/libreoffice-resolver.ts";
import { getPythonPath } from "../lib/runtime/paths.ts";
import {
  computePythonRuntimeStamp,
  resolveRuntimeLockPath,
  PYTHON_RUNTIME_VER,
  PYTHON_RUNTIME_TAG,
} from "../lib/runtime/python-installer.ts";

export const spreadsheetProbeTestPromise = (async () => {
  // Every packaged release target needs its own resolved wheel set. A single
  // host lock can pass local tests while making another release un-installable.
  {
    const targets: Array<[NodeJS.Platform, string]> = [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ];
    const requiredPins = [
      "formulas==1.3.4",
      "numpy==1.26.4",
      "onnxruntime==1.19.2",
      "opencv-python==4.10.0.84",
      "pypdfium2==4.30.0",
      "rapidocr-onnxruntime==1.4.4",
      "scipy==1.14.1",
    ];

    for (const [platform, arch] of targets) {
      const lockPath = resolveRuntimeLockPath(platform, arch);
      assert.ok(existsSync(lockPath), `tracked platform lock should exist: ${lockPath}`);
      const lock = readFileSync(lockPath, "utf8");
      for (const pin of requiredPins) {
        assert.match(lock, new RegExp(`^${pin.replaceAll(".", "\\.")} \\\\`, "m"), `${path.basename(lockPath)} should contain ${pin}`);
      }
    }

    const stamp = computePythonRuntimeStamp({ platform: "darwin", arch: "arm64" });
    assert.ok(stamp.startsWith(`${PYTHON_RUNTIME_VER}+${PYTHON_RUNTIME_TAG}+`), "stamp should include lock hash suffix");
    assert.notEqual(stamp, `${PYTHON_RUNTIME_VER}+${PYTHON_RUNTIME_TAG}`, "stamp without lock is only for missing lock");
  }

  const fixtures = getSpreadsheetFixtureDir();
  assert.ok(existsSync(path.join(fixtures, "legacy-input.xls")), "legacy-input.xls fixture required");
  assert.ok(existsSync(path.join(fixtures, "formula-ok.xlsx")), "formula-ok.xlsx fixture required");

  const python = getPythonPath();
  if (!existsSync(python)) {
    console.log("spreadsheet-probe: python missing, skipping live probe ⚠");
    return;
  }

  const lo = resolveLibreOffice();
  const caps = await getSpreadsheetCapabilities({
    // When LO missing, probe must skip real recalc explicitly (not fail falsely)
    runRecalcProbe: lo.ok,
    resolveLo: () => lo,
  });

  assert.equal(caps.python.ok, true, "python should be ok");
  assert.equal(caps.packages.xlrd.ok, true, "xlrd must be installed for CR-S1");
  assert.equal(caps.packages.openpyxl.ok, true);
  assert.equal(caps.read.xls, true, "xls fixture read via xlrd must pass");
  assert.equal(caps.read.xlsx, true);
  assert.equal(caps.write.xlsx, true);
  assert.equal(caps.write.preserveXlsm, false, "v1 does not claim macro preservation");

  if (!lo.ok) {
    assert.equal(caps.recalc.ok, false);
    assert.equal(caps.recalc.skipped, true, "missing LO must set skipped=true (explicit skip)");
    assert.equal(caps.recalc.errorCode, "recalc_unavailable");
    assert.ok(
      caps.problems.some((p) => p.code === "recalc_unavailable" && p.remediation === "install_libreoffice"),
      "should surface install_libreoffice remediation"
    );
    console.log("spreadsheet-probe: LibreOffice missing — real recalc explicitly skipped ✓");
  } else {
    // Real recalc only when LO present
    assert.equal(caps.recalc.ok, true, "LO present: SUM probe should yield 3");
    assert.ok(caps.recalc.executable && path.isAbsolute(caps.recalc.executable));
    console.log("spreadsheet-probe: LibreOffice recalc probe passed ✓");
  }

  console.log("spreadsheet-probe: all checks passed ✓");
})();
