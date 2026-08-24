"use strict";

const path = require("node:path");
const { notarize, stapleApp } = require("@electron/notarize");

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.warn("electron-after-sign: Apple notarization credentials are incomplete; skipping notarization.");
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await notarize({ appPath, appleId, appleIdPassword, teamId });
  await stapleApp({ appPath });
};
