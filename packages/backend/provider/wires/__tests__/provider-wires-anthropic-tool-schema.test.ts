import { describe, expect, it } from "vitest";
import { toAnthropicInputSchema } from "../provider-wires-anthropic-tool-schema.js";
import { toAnthropicTools } from "../provider-wires-anthropic-messages.js";

const RESOURCE_LIKE = {
	type: "object",
	oneOf: [
		{
			type: "object",
			description: "Open a page",
			properties: {
				op: { type: "string", const: "open" },
				ref: { type: "string", description: "address" },
				url: { type: "string" },
			},
			required: ["op", "url"],
		},
		{
			type: "object",
			description: "List tabs",
			properties: {
				read: { type: "string", const: "tabs" },
				ref: { type: "string", description: "address" },
			},
			required: ["read"],
		},
		{
			type: "object",
			description: "Close a tab",
			properties: {
				op: { type: "string", const: "close" },
				ref: { type: "string", description: "address" },
			},
			required: ["op"],
		},
	],
};

describe("toAnthropicInputSchema", () => {
	it("leaves schemas without a top-level union untouched", () => {
		const plain = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
		expect(toAnthropicInputSchema(plain)).toBe(plain);
	});

	it("flattens a top-level oneOf into one object schema", () => {
		const flat = toAnthropicInputSchema(RESOURCE_LIKE);
		for (const key of ["oneOf", "anyOf", "allOf"]) expect(flat).not.toHaveProperty(key);
		expect(flat.type).toBe("object");
		expect(flat.properties).toEqual({
			op: { type: "string", enum: ["open", "close"] },
			ref: { type: "string", description: "address" },
			url: { type: "string" },
			read: { type: "string", const: "tabs" },
		});
		expect(flat).not.toHaveProperty("required");
		expect(flat.description).toContain("Pass exactly one of these shapes");
		expect(flat.description).toContain('- Open a page (op="open", url)');
		expect(flat.description).toContain('- List tabs (read="tabs")');
	});

	it("keeps required keys shared by every branch, and unions them for allOf", () => {
		const shared = toAnthropicInputSchema({
			oneOf: [
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
				{ type: "object", properties: { a: { type: "number" }, b: { type: "string" } }, required: ["a", "b"] },
			],
		});
		expect(shared.required).toEqual(["a"]);
		expect((shared.properties as Record<string, unknown>).a).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }],
		});

		const all = toAnthropicInputSchema({
			allOf: [
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
				{ type: "object", properties: { b: { type: "string" } }, required: ["b"] },
			],
		});
		expect(all.required).toEqual(["a", "b"]);
		expect(all).not.toHaveProperty("description");
	});

	it("is applied on the wire by toAnthropicTools", () => {
		const [tool] = toAnthropicTools([
			{ name: "browser", description: "d", parameters: RESOURCE_LIKE },
		] as never) ?? [];
		expect(tool.input_schema).not.toHaveProperty("oneOf");
	});
});
