import { expect, describe, beforeAll, afterAll, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	getSchemaRepo,
	getHeaders,
	getURL,
	initDB,
	zigReposInsert,
	logger,
	getZigZonURL,
	SchemaZon,
	zon2json,
	getZigBuildURL,
} from "./main.jsx";

describe("Fetching and insertion", () => {
	let db;

	beforeAll(() => {
		db = new Database(":memory:");
		initDB(db);
	});

	/**
	 * @param {'github' | 'codeberg'} type
	 * @returns {Promise<any>}
	 */
	async function repoFetchAndParse(type) {
		const file = Bun.file(`./.http-cache/repo-${type}.json`);
		const schema = getSchemaRepo(type);
		let data;
		if (file.size === 0) {
			const url = getURL(type);
			const res = await fetch(url, { headers: getHeaders(type) });
			data = await res.json();
			await Bun.write(file, JSON.stringify(data));
		} else {
			data = JSON.parse(await file.text());
		}
		return schema.parse(data);
	}

	/**
	 * @param {'github' | 'codeberg'} type
	 * @param {string} full_name
	 * @param {string} default_branch
	 * @returns {Promise<any>}
	 */
	async function zonFetchAndParse(type, full_name, default_branch) {
		const file = Bun.file(`./.http-cache/zon-${type}.json`);
		let data;
		if (file.size === 0) {
			const url = getZigZonURL(type, full_name, default_branch);
			console.log(url);
			const res = await fetch(url);
			data = await res.text();
			await Bun.write(file, data);
		} else {
			data = await file.text();
		}
		return SchemaZon.parse(JSON.parse(zon2json(data)));
	}

	/**
	 * @param {'github' | 'codeberg'} type
	 * @param {string} full_name
	 * @param {string} default_branch
	 * @returns {Promise<any>}
	 */
	async function buildZigFetch(type, full_name, default_branch) {
		const file = Bun.file(`./.http-cache/build-${type}.json`);
		let data;
		if (file.size === 0) {
			const url = getZigBuildURL(type, full_name, default_branch);
			const res = await fetch(url);
			data = await res.text();
			await Bun.write(file, data);
		} else {
			data = await file.text();
		}
		return data;
	}

	it("should fetch GitHub repo, insert into zig_repos", async () => {
		const githubData = await repoFetchAndParse("github");
		zigReposInsert(db, [githubData]);
		const stmt = db.prepare(
			"SELECT * FROM zig_repos WHERE full_name = 'ziglang/zig'",
		);
		const result = stmt.get();
		expect(result).toBeDefined();
	});

	it("should fetch Codeberg repo, insert into zig_repos", async () => {
		const codebergData = await repoFetchAndParse("codeberg");
		zigReposInsert(db, [codebergData]);
		const stmt = db.prepare(
			"SELECT * FROM zig_repos WHERE full_name = 'codeberg:dude_the_builder/zg'",
		);
		const result = stmt.get();
		expect(result).toBeDefined();
		expect(result.full_name).toBe("codeberg:dude_the_builder/zg");
	});

	it("should fetch and parse ziglang/zig build.zig.zon", async () => {
		const data = await zonFetchAndParse("github", "ziglang/zig", "master");
		expect(data).toBeDefined();
	});

	it("should fetch and parse codeberg:dude_the_builder/zg build.zig.zon", async () => {
		const data = await zonFetchAndParse(
			"codeberg",
			"dude_the_builder/zg",
			"master",
		);
		expect(data).toBeDefined();
	});

	it("should fetch and parse ziglang/zig build.zig", async () => {
		const data = await buildZigFetch("github", "ziglang/zig", "master");
		expect(data).toBeDefined();
	});

	it("should fetch and parse codeberg:dude_the_builder/zg build.zig", async () => {
		const data = await buildZigFetch(
			"codeberg",
			"dude_the_builder/zg",
			"master",
		);
		expect(data).toBeDefined();
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
