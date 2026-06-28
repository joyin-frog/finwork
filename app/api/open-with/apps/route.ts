import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

type OpenWithApp = {
  name: string;
  path: string;
  iconUrl?: string;
};

type AppCandidate = {
  name: string;
  aliases: string[];
  winPatterns?: string[];
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fileName = url.searchParams.get("name") ?? "";
  const mimeType = url.searchParams.get("mimeType") ?? "";
  const apps = await listApplications(fileName, mimeType);
  return NextResponse.json({ ok: true, data: { apps } });
}

async function listApplications(fileName: string, mimeType: string) {
  const candidates = getCandidatesForFile(fileName, mimeType);
  if (process.platform === "win32") return listWindowsApplications(candidates);
  if (process.platform !== "darwin") return [{ name: "Default app", path: "" }];

  const installed = await listMacApplications();
  const apps: OpenWithApp[] = [];
  for (const candidate of candidates) {
    const app = findCandidateApp(installed, candidate);
    if (app && !apps.some((item) => item.path === app.path)) apps.push(app);
  }

  return apps.length ? apps : [{ name: "Default app", path: "" }];
}

async function listMacApplications() {
  const roots = [
    "/Applications",
    "/System/Applications",
    path.join(process.env.HOME ?? "", "Applications")
  ].filter(Boolean);
  const byName = new Map<string, OpenWithApp>();

  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
        const name = entry.name.replace(/\.app$/, "");
        const appPath = path.join(root, entry.name);
        byName.set(name.toLowerCase(), {
          name,
          path: appPath,
          iconUrl: `/api/open-with/icon?path=${encodeURIComponent(appPath)}`
        });
      }
    } catch {
      // Some application roots may not exist or be readable.
    }
  }

  return [...byName.values()];
}

function findCandidateApp(installed: OpenWithApp[], candidate: AppCandidate) {
  const aliases = candidate.aliases.map((alias) => alias.toLowerCase());
  return installed.find((app) => {
    const name = app.name.toLowerCase();
    return aliases.some((alias) => name === alias || name.includes(alias));
  });
}

async function listWindowsApplications(candidates: AppCandidate[]) {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : "",
    process.env.ProgramFiles ?? "",
    process.env["ProgramFiles(x86)"] ?? ""
  ].filter(Boolean);

  const apps: OpenWithApp[] = [];
  for (const candidate of candidates) {
    const found = await findFirstExecutable(roots, candidate.winPatterns ?? [], 5);
    if (found) apps.push({ name: candidate.name, path: found });
  }

  return apps.length
    ? apps
    : [
        { name: "Default app", path: "" },
        { name: "Choose app...", path: "__choose__" }
      ];
}

function getCandidatesForFile(fileName: string, mimeType: string): AppCandidate[] {
  const ext = path.extname(fileName).toLowerCase();
  if (isSpreadsheet(ext, mimeType)) {
    return [
      app("WPS Office", ["wps office", "wps"], ["wps.exe", "et.exe"]),
      app("Microsoft Excel", ["microsoft excel", "excel"], ["EXCEL.EXE", "excel.exe"]),
      app("Numbers", ["numbers"]),
      app("LibreOffice", ["libreoffice"], ["soffice.exe"])
    ];
  }
  if (isWord(ext, mimeType)) {
    return [
      app("WPS Office", ["wps office", "wps"], ["wps.exe", "wpp.exe"]),
      app("Microsoft Word", ["microsoft word", "word"], ["WINWORD.EXE", "winword.exe"]),
      app("Pages", ["pages"]),
      app("LibreOffice", ["libreoffice"], ["soffice.exe"])
    ];
  }
  if (isPresentation(ext, mimeType)) {
    return [
      app("WPS Office", ["wps office", "wps"], ["wps.exe", "wpp.exe"]),
      app("PowerPoint", ["microsoft powerpoint", "powerpoint"], ["POWERPNT.EXE", "powerpnt.exe"]),
      app("Keynote", ["keynote"]),
      app("LibreOffice", ["libreoffice"], ["soffice.exe"])
    ];
  }
  if (isPdf(ext, mimeType)) {
    return [
      app("WPS Office", ["wps office", "wps"], ["wps.exe"]),
      app("Preview", ["preview"]),
      app("Adobe Acrobat", ["adobe acrobat", "acrobat"], ["Acrobat.exe", "AcroRd32.exe"]),
      app("PDF Expert", ["pdf expert"])
    ];
  }
  if (mimeType.startsWith("image/")) {
    return [
      app("Preview", ["preview"]),
      app("Photos", ["photos"]),
      app("Adobe Photoshop", ["photoshop"], ["Photoshop.exe"])
    ];
  }
  return [
    app("VS Code", ["visual studio code", "vs code", "code"], ["Code.exe"]),
    app("Cursor", ["cursor"], ["Cursor.exe"]),
    app("Zed", ["zed"]),
    app("TextEdit", ["textedit"]),
    app("Notepad", ["notepad"], ["notepad.exe"])
  ];
}

function app(name: string, aliases: string[], winPatterns: string[] = []): AppCandidate {
  return { name, aliases, winPatterns };
}

function isSpreadsheet(ext: string, mimeType: string) {
  return [".xls", ".xlsx", ".xlsm", ".csv"].includes(ext) || mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType === "text/csv";
}

function isWord(ext: string, mimeType: string) {
  return [".doc", ".docx"].includes(ext) || mimeType.includes("word");
}

function isPresentation(ext: string, mimeType: string) {
  return [".ppt", ".pptx"].includes(ext) || mimeType.includes("presentation") || mimeType.includes("powerpoint");
}

function isPdf(ext: string, mimeType: string) {
  return ext === ".pdf" || mimeType.includes("pdf");
}

async function findFirstExecutable(roots: string[], names: string[], maxDepth: number): Promise<string | null> {
  const queue = roots.map((root) => ({ dir: root, depth: 0 }));
  const wanted = new Set(names.map((name) => name.toLowerCase()));

  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;

    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return fullPath;
      if (entry.isDirectory()) queue.push({ dir: fullPath, depth: current.depth + 1 });
    }
  }
  return null;
}
