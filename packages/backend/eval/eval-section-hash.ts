import { createHash } from "node:crypto";

/**
 * Compute per-section hashes and the joint promptVersion from named sections.
 *
 * - section hash = sha256(section content).slice(0, 8)
 * - promptVersion = sha256(all section hashes sorted by name, concatenated).slice(0, 8)
 */
export function hashSections(
	sections: Array<{ name: string; content: string }>,
): { sectionHashes: Record<string, string>; promptVersion: string } {
	const sectionHashes: Record<string, string> = {};
	for (const { name, content } of sections) {
		sectionHashes[name] = createHash("sha256")
			.update(content)
			.digest("hex")
			.slice(0, 8);
	}

	const sortedNames = Object.keys(sectionHashes).sort();
	const joint = sortedNames
		.map((name) => `${name}:${sectionHashes[name]}`)
		.join("\n");
	const promptVersion = createHash("sha256")
		.update(joint)
		.digest("hex")
		.slice(0, 8);

	return { sectionHashes, promptVersion };
}
