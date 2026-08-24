"use strict";

const fs = require("node:fs");
const path = require("node:path");

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function createReadAccessPolicy() {
  const exactPaths = new Set();
  const rootPaths = new Set();

  async function canonicalize(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error("Expected an absolute file path");
    }
    return fs.promises.realpath(candidate);
  }

  async function grant(paths, { directory = false } = {}) {
    const values = Array.isArray(paths) ? paths : [paths];
    for (const value of values) {
      const canonical = await canonicalize(value);
      (directory ? rootPaths : exactPaths).add(canonical);
    }
  }

  async function assertReadable(candidate) {
    const canonical = await canonicalize(candidate);
    if (exactPaths.has(canonical)) return canonical;
    for (const root of rootPaths) {
      if (pathIsWithin(canonical, root)) return canonical;
    }
    throw new Error("File path is outside the authorized desktop read scope");
  }

  return { assertReadable, grant };
}

module.exports = { createReadAccessPolicy, pathIsWithin };
