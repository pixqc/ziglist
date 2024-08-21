import { expect, describe, beforeAll, afterAll, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	getSchemaRepo,
	getHeaders,
	initDB,
	insertZigRepos,
	logger,
	getZigZonURL,
	fetchMetadata,
	SchemaZon,
	zon2json,
	getZigBuildURL,
	updateMetadata,
} from "./main.jsx";
import { z } from "zod";

/**
 * @param {'github' | 'codeberg'} type
 * @returns {string}
 */
const getURL = (type) => {
	if (type === "github") {
		return "https://api.github.com/repos/ziglang/zig";
	} else if (type === "codeberg") {
		// because the deps has both path and url, good for testing
		return "https://codeberg.org/api/v1/repos/GalaxyShard/zig-git2";
	}
	return ""; // unreachable
};

describe("Fetching and insertion", () => {
	const githubFullname = "ziglang/zig";
	const codebergFullname = "codeberg:GalaxyShard/zig-git2";

	let db;
	beforeAll(() => {
		db = new Database("test.sqlite");
		initDB(db);
	});

	/**
	 * @param {'github' | 'codeberg'} type
	 * @returns {Promise<z.infer<ReturnType<typeof getSchemaRepo>>>}
	 */
	async function repoFetchAndParse(type) {
		const file = Bun.file(`./.http-cache/repo-${type}.json`);
		const schema = getSchemaRepo(type);
		if (file.size > 0) return schema.parse(JSON.parse(await file.text()));
		const url = getURL(type);
		const res = await fetch(url, { headers: getHeaders(type) });
		const data = await res.json();
		await Bun.write(file, JSON.stringify(data));
		return schema.parse(data);
	}

	it("should fetch GitHub repo, insert into zig_repos", async () => {
		const githubData = await repoFetchAndParse("github");
		insertZigRepos(db, [githubData]);
		const stmt = db.prepare("SELECT * FROM zig_repos WHERE full_name = ?");
		const result = stmt.get(githubFullname);
		expect(result).toBeDefined();
	});

	it("should fetch Codeberg repo, insert into zig_repos", async () => {
		const codebergData = await repoFetchAndParse("codeberg");
		insertZigRepos(db, [codebergData]);
		const stmt = db.prepare("SELECT * FROM zig_repos WHERE full_name = ?");
		const result = stmt.get(codebergFullname);
		expect(result).toBeDefined();
		expect(result.full_name).toBe(codebergFullname);
	});

	it("should fetch and parse ziglang/zig build.zig.zon", async () => {
		const [zonData, buildData] = await Promise.all([
			fetchMetadata(getZigZonURL("github", githubFullname, "master")),
			fetchMetadata(getZigBuildURL("github", githubFullname, "master")),
		]);

		expect(zonData.status).toBe(200);
		expect(buildData.status).toBe(200);
		expect(zonData.fetchedAt).toBeGreaterThan(0);
		const parsed = SchemaZon.safeParse(JSON.parse(zon2json(zonData.content)));
		expect(parsed.success).toBe(true);

		const metadata = {
			full_name: githubFullname,
			min_zig_version: parsed.data?.minimum_zig_version,
			buildZigExists: true,
			zonExists: true,
			fetchedAt: zonData.fetchedAt,
		};

		updateMetadata(db, [metadata]);
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
