import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const resources = path.resolve(process.argv[2] || (
  process.platform === "win32"
    ? "dist-electron/win-unpacked/resources"
    : `dist-electron/mac-${process.arch}/Finwork.app/Contents/Resources`
));
const installPythonDeps = process.argv.includes("--install-python-deps");
const isWindows = process.platform === "win32";
const server = path.join(resources, "next-server");
const nodeBinary = path.join(resources, "node", isWindows ? "node.exe" : "node");
const pythonArchive = path.join(server, "workers", "python-runtime.tar.gz");
const runtimeLock = path.join(server, "runtime-lock", `${process.platform}-${process.arch}.txt`);
const required = [
  path.join(server, "server.js"),
  path.join(server, "requirements.txt"),
  path.join(resources, "parent-watch.cjs"),
  nodeBinary,
  pythonArchive,
  runtimeLock,
  path.join(server, "node_modules", "highlight.js", "styles", "atom-one-light.css"),
  path.join(server, "node_modules", "highlight.js", "styles", "atom-one-dark.css"),
];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`Packaged resource is missing: ${file}`);
}

const nodeEvidence = execFileSync(nodeBinary, ["-e", "const s=require('node:sqlite');console.log(JSON.stringify({version:process.version,arch:process.arch,sqlite:Boolean(s.DatabaseSync)}))"], {
  encoding: "utf8",
  timeout: 15_000,
}).trim();

const extraction = mkdtempSync(path.join(os.tmpdir(), "finwork-packaged-python-"));
try {
  execFileSync("tar", ["-xzf", pythonArchive, "-C", extraction, "--strip-components=1"], { timeout: 60_000 });
  const pythonBinary = path.join(extraction, isWindows ? "python.exe" : "bin/python3");
  if (!existsSync(pythonBinary)) throw new Error(`Extracted Python is missing: ${pythonBinary}`);
  const pythonEvidence = execFileSync(pythonBinary, ["-c", "import json,platform,sqlite3,ssl,sys;print(json.dumps({'version':platform.python_version(),'machine':platform.machine(),'sqlite':sqlite3.sqlite_version,'openssl':ssl.OPENSSL_VERSION,'executable':sys.executable}))"], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
  let pythonWorker = null;
  let pythonNativeDeps = null;
  if (installPythonDeps) {
    execFileSync(pythonBinary, [
      "-m", "pip", "install",
      "--require-hashes",
      "--only-binary=:all:",
      "-r", runtimeLock,
    ], { stdio: "inherit", timeout: 15 * 60_000 });
    pythonWorker = JSON.parse(execFileSync(
      pythonBinary,
      [path.join(server, "workers", "finance_worker.py"), "--selfcheck"],
      { encoding: "utf8", timeout: 60_000 }
    ));
    if (!pythonWorker.ok || pythonWorker.missing.length > 0) {
      throw new Error(`Packaged Python worker selfcheck failed: ${JSON.stringify(pythonWorker)}`);
    }
    pythonNativeDeps = JSON.parse(execFileSync(pythonBinary, [
      "-c",
      "import cv2,formulas,json,numpy,onnxruntime,pypdfium2,scipy;from rapidocr_onnxruntime import RapidOCR;print(json.dumps({'numpy':numpy.__version__,'scipy':scipy.__version__,'opencv':cv2.__version__,'onnxruntime':onnxruntime.__version__,'formulas':formulas.__version__,'rapidocr':RapidOCR.__name__}))",
    ], { encoding: "utf8", timeout: 60_000 }));
  }
  const archiveSha256 = createHash("sha256").update(readFileSync(pythonArchive)).digest("hex");
  console.log(JSON.stringify({
    resources,
    node: JSON.parse(nodeEvidence),
    python: JSON.parse(pythonEvidence),
    pythonWorker,
    pythonNativeDeps,
    pythonArchiveSha256: archiveSha256,
    runtimeLock: path.basename(runtimeLock),
  }, null, 2));
} finally {
  rmSync(extraction, { recursive: true, force: true });
}
