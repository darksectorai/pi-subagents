export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	let currentBlock: string | undefined;
	for (const line of frontmatterBlock.split("\n")) {
		const nestedMatch = line.match(/^\s+([\w-]+):\s*(.*)$/);
		if (nestedMatch && currentBlock) {
			let value = nestedMatch[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[`${currentBlock}.${nestedMatch[1]}`] = value;
			continue;
		}

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
			currentBlock = value === "" ? match[1] : undefined;
			continue;
		}
		if (line.trim() !== "") currentBlock = undefined;
	}

	return { frontmatter, body };
}
