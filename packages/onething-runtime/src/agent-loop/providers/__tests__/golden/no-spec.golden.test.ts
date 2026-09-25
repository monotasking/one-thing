/**
 * golden 红线(§7.2):**没有 spec** 的自定义服务商,解出的事件序列与批 4 之前逐字一致。
 *
 * 期望文件是改动前录的(`ONETHING_GOLDEN_WRITE=1` 才重录 —— 重录等于改红线,别顺手跑)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerCustomProvidersForTest } from "../../../../providers/__tests__/custom-manifest-fixture.js";
import { GOLDEN_FIXTURES, goldenExpectedPath, runGolden } from "./golden-harness.js";

registerCustomProvidersForTest(["custom-golden-plain"]);

describe("golden:无 spec 的自定义服务商逐字不变", () => {
	for (const name of GOLDEN_FIXTURES) {
		it(name, async () => {
			const { events } = await runGolden("custom-golden-plain", name);
			const actual = `${JSON.stringify(events, null, 2)}\n`;
			const file = goldenExpectedPath(name);
			if (process.env.ONETHING_GOLDEN_WRITE === "1") {
				writeFileSync(file, actual);
			}
			expect(actual).toBe(readFileSync(file, "utf8"));
		});
	}
});
