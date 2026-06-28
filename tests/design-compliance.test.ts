import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// CSS files to audit — excludes tokens.css (source of truth) and base.css (browser resets)
const STYLES_DIR = path.join(process.cwd(), "app/styles");
const SKIP_FILES = new Set(["tokens.css", "base.css"]);

function loadCssFiles(): { file: string; lines: string[] }[] {
  return readdirSync(STYLES_DIR)
    .filter((f) => f.endsWith(".css") && !SKIP_FILES.has(f))
    .map((f) => ({
      file: f,
      lines: readFileSync(path.join(STYLES_DIR, f), "utf8").split("\n"),
    }));
}

function formatViolations(violations: { file: string; line: number; text: string }[]) {
  return violations
    .map(({ file, line, text }) => `  ${file}:${line}  ${text.trim()}`)
    .join("\n");
}

const cssFiles = loadCssFiles();

// T1 — Font sizes: only 11/12/13/14/16/18/26px (or var(--font-*)) allowed
const ALLOWED_FONT_SIZES = new Set([11, 12, 13, 14, 16, 18, 26]);
const FONT_SIZE_RE = /font-size:\s*(\d+)px/;

export const designComplianceTestPromise = (async () => {
  // ── T1: Illegal font sizes ──────────────────────────────────────────────────
  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      lines.forEach((text, i) => {
        const m = text.match(FONT_SIZE_RE);
        if (m && !ALLOWED_FONT_SIZES.has(Number(m[1]))) {
          violations.push({ file, line: i + 1, text });
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T1 FAIL — ${violations.length} illegal font-size value(s) (allowed: 11/12/13/14/16/18/26px):\n${formatViolations(violations)}`
    );
  }

  // ── T2: Illegal border-radius ───────────────────────────────────────────────
  // Allowed: 0, 6px, 8px, 12px, 999px — and compound variants (e.g. "6px 6px 0 0")
  // Also allow: 28px / 22px ONLY in settings-float.css (window outer container)
  const ALLOWED_RADII = new Set([0, 6, 8, 12, 999]);
  const BR_RE = /border-radius:\s*([\d.]+)px/g;

  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      lines.forEach((text, i) => {
        let m: RegExpExecArray | null;
        const re = new RegExp(BR_RE.source, "g");
        while ((m = re.exec(text)) !== null) {
          const val = Number(m[1]);
          const isSettingsWindowException =
            file === "settings-float.css" && (val === 28 || val === 22);
          if (!ALLOWED_RADII.has(val) && !isSettingsWindowException) {
            violations.push({ file, line: i + 1, text });
          }
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T2 FAIL — ${violations.length} illegal border-radius value(s) (allowed: 0/6/8/12/999px; 28/22 only in settings-float.css window):\n${formatViolations(violations)}`
    );
  }

  // ── T3: Hardcoded #fff / #000 as color or background ───────────────────────
  // Exception: settings-float.css .appearance-color-swatch* — white text over
  // user-chosen dynamic background color has no suitable token.
  const HEX_LITERAL_RE = /(?:^|[^-\w])(color|background(?:-color)?)\s*:\s*(#fff\b|#000\b)/i;
  const SWATCH_EXCEPTION_RE = /appearance-color-swatch/;

  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      let inSwatchBlock = false;
      lines.forEach((text, i) => {
        if (SWATCH_EXCEPTION_RE.test(text)) inSwatchBlock = true;
        if (inSwatchBlock && text.trim() === "}") inSwatchBlock = false;
        if (!inSwatchBlock && HEX_LITERAL_RE.test(text)) {
          violations.push({ file, line: i + 1, text });
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T3 FAIL — ${violations.length} hardcoded #fff/#000 color(s):\n${formatViolations(violations)}`
    );
  }

  // ── T4: --surface-hover used as border-color ────────────────────────────────
  const SURFACE_HOVER_BORDER_RE = /border(?:-color)?\s*:[^;]*var\(--surface-hover\)/;

  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      lines.forEach((text, i) => {
        if (SURFACE_HOVER_BORDER_RE.test(text)) {
          violations.push({ file, line: i + 1, text });
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T4 FAIL — ${violations.length} instance(s) of --surface-hover used as border-color (use --border instead):\n${formatViolations(violations)}`
    );
  }

  // ── T5: --accent used as border-color on non-CTA elements ──────────────────
  // Exception: CTA buttons that also use --accent as background
  // (composer-send-button, primary buttons in preview.css upload zone)
  const ACCENT_BORDER_RE = /border-color\s*:\s*var\(--accent\)/;
  const ACCENT_BORDER_EXCEPTION_RE = /composer-send-button|primary|upload|fab-btn|preview-download/;

  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      let context = "";
      lines.forEach((text, i) => {
        // Track selector context (very simplified)
        if (text.trim().endsWith("{")) context = text;
        if (ACCENT_BORDER_RE.test(text) && !ACCENT_BORDER_EXCEPTION_RE.test(context)) {
          violations.push({ file, line: i + 1, text });
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T5 FAIL — ${violations.length} non-CTA element(s) using --accent as border-color (use --focus-border instead):\n${formatViolations(violations)}`
    );
  }

  // ── T6: var(--token, #hardcoded) fallback hex in component CSS ──────────────
  const VAR_FALLBACK_HEX_RE = /var\(--[a-z-]+,\s*#[0-9a-fA-F]{3,6}\)/;

  {
    const violations: { file: string; line: number; text: string }[] = [];
    for (const { file, lines } of cssFiles) {
      lines.forEach((text, i) => {
        if (VAR_FALLBACK_HEX_RE.test(text)) {
          violations.push({ file, line: i + 1, text });
        }
      });
    }
    assert.equal(
      violations.length,
      0,
      `T6 FAIL — ${violations.length} var() with hardcoded hex fallback(s) (tokens are always defined — remove fallbacks):\n${formatViolations(violations)}`
    );
  }

  console.log("design-compliance: all 6 checks passed ✓");
})();
