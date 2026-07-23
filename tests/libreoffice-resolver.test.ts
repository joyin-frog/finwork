import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveLibreOffice,
  systemLibreOfficeCandidates,
} from "../lib/runtime/libreoffice-resolver.ts";

export const libreofficeResolverTestPromise = (async () => {
  // Priority: managed → system paths → PATH
  {
    const r = resolveLibreOffice({
      platform: "darwin",
      homeDir: "/Users/fake",
      managedCandidates: ["/opt/finwork/lo/soffice"],
      exists: (p) => p === "/opt/finwork/lo/soffice",
      readVersion: () => "LibreOffice 24.8.2.1",
      which: () => null,
    });
    assert.equal(r.ok, true, "managed should win");
    if (r.ok) {
      assert.equal(r.provider, "managed_libreoffice");
      assert.equal(r.executable, "/opt/finwork/lo/soffice");
      assert.equal(r.version, "24.8.2.1");
      assert.ok(path.isAbsolute(r.executable), "must be absolute");
    }
  }

  {
    const systemPath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    const r = resolveLibreOffice({
      platform: "darwin",
      homeDir: "/Users/fake",
      managedCandidates: [],
      exists: (p) => p === systemPath,
      readVersion: () => "LibreOffice 7.6.0",
      which: () => "/usr/local/bin/soffice", // PATH must not beat system app path when system exists
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.provider, "system_libreoffice");
      assert.equal(r.executable, systemPath);
    }
  }

  {
    const r = resolveLibreOffice({
      platform: "darwin",
      homeDir: "/Users/fake",
      managedCandidates: [],
      exists: () => false,
      pathEnv: "/empty",
      which: () => "/opt/homebrew/bin/soffice",
      readVersion: () => "LibreOffice 24.2",
    });
    // which returns absolute path; exists for that path must be true for success —
    // our which mock returns a path but exists is always false → unavailable
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errorCode, "recalc_unavailable");
      assert.ok(r.installHint.includes("LibreOffice"), "should include install guidance");
    }
  }

  {
    const pathHit = "/opt/homebrew/bin/soffice";
    const r = resolveLibreOffice({
      platform: "darwin",
      homeDir: "/Users/fake",
      managedCandidates: [],
      exists: (p) => p === pathHit,
      which: () => pathHit,
      readVersion: () => "LibreOffice 24.2.0",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.executable, pathHit);
      assert.ok(path.isAbsolute(r.executable));
    }
  }

  {
    const candidates = systemLibreOfficeCandidates("linux", "/home/u");
    assert.ok(candidates.some((c) => c.includes("soffice") || c.includes("libreoffice")));
    const win = systemLibreOfficeCandidates("win32", "C:\\Users\\u");
    assert.ok(win.every((c) => path.isAbsolute(c) || /^[A-Za-z]:\\/.test(c) || c.includes("LibreOffice")));
  }

  // Never return bare "soffice" as executable
  {
    const r = resolveLibreOffice({
      platform: "linux",
      homeDir: "/home/u",
      exists: () => false,
      which: () => "soffice", // relative / bare — must be rejected
      readVersion: () => "x",
    });
    assert.equal(r.ok, false, "bare soffice name must not be accepted");
  }

  console.log("libreoffice-resolver: all checks passed ✓");
})();
