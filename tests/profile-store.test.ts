import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const profileStoreTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-profile-test-"));
  const profilePath = path.join(dir, "profile.json");

  const origProfile = process.env.FINANCE_AGENT_PROFILE_PATH;
  process.env.FINANCE_AGENT_PROFILE_PATH = profilePath;

  try {
    const { readCompanyProfile, mergeCompanyProfile, writeCompanyProfile } = await import("../lib/profile/file-store.ts");
    const { GET: profileGET, PUT: profilePUT } = await import("../app/api/profile/route.ts");

    // ── AC1: 文件不存在时 readCompanyProfile 返回 {} ───────────────────────
    const emptyProfile = await readCompanyProfile();
    assert.deepEqual(emptyProfile, {}, "AC1 FAIL: 文件不存在时应返回 {}");

    // ── AC2: writeCompanyProfile + readCompanyProfile roundtrip ─────────────
    await writeCompanyProfile({ region: "上海市松江区", isHighTech: true });
    const afterWrite = await readCompanyProfile();
    assert.equal(afterWrite.region, "上海市松江区", "AC2 FAIL: region 应写入");
    assert.equal(afterWrite.isHighTech, true, "AC2 FAIL: isHighTech 应写入");

    // ── AC3: mergeCompanyProfile 浅合并，不覆盖未传字段 ───────────────────
    await mergeCompanyProfile({ taxpayerType: "一般纳税人" });
    const afterMerge = await readCompanyProfile();
    assert.equal(afterMerge.region, "上海市松江区", "AC3 FAIL: merge 不应清掉旧字段");
    assert.equal(afterMerge.taxpayerType, "一般纳税人", "AC3 FAIL: merge 应加入新字段");

    // ── AC4: mergeCompanyProfile extra 深合并 ─────────────────────────────
    await writeCompanyProfile({ extra: { foo: 1 } });
    await mergeCompanyProfile({ extra: { bar: 2 } });
    const afterExtraMerge = await readCompanyProfile();
    assert.equal((afterExtraMerge.extra as Record<string, unknown>)?.foo, 1, "AC4 FAIL: extra.foo 应保留");
    assert.equal((afterExtraMerge.extra as Record<string, unknown>)?.bar, 2, "AC4 FAIL: extra.bar 应合并进");

    // ── AC5: GET/PUT API roundtrip ─────────────────────────────────────────
    const putRes = await profilePUT(
      new Request("http://local/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: { region: "北京市海淀区", scaleRevenueWan: 500 } }),
      })
    );
    assert.equal(putRes.status, 200, "AC5 FAIL: PUT 合法 profile 应 200");

    const getRes = await profileGET();
    const getBody = (await getRes.json()) as { ok: boolean; data: { profile: Record<string, unknown>; updatedAt: string | null } };
    assert.ok(getBody.ok, "AC5 FAIL: GET 应成功");
    assert.equal(getBody.data.profile.region, "北京市海淀区", "AC5 FAIL: GET 应返回 PUT 的内容");
    assert.equal(getBody.data.profile.scaleRevenueWan, 500, "AC5 FAIL: scaleRevenueWan 应写入");

    // ── AC6: PUT 非法请求体应 400 ──────────────────────────────────────────
    const badRes = await profilePUT(
      new Request("http://local/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "not-an-object" }),
      })
    );
    assert.equal(badRes.status, 400, "AC6 FAIL: profile 非对象应 400");

    console.log("profile-store: all 6 checks passed ✓");
  } finally {
    process.env.FINANCE_AGENT_PROFILE_PATH = origProfile;
    rmSync(dir, { recursive: true, force: true });
  }
})();
