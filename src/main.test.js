import { expect, describe, beforeAll, afterAll, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	getSchemaRepo,
	getHeaders,
	getURL,
	initDB,
	zigReposInsert,
	logger,
} from "./main.jsx";

describe("Repository fetching and insertion", () => {
	let db;

	beforeAll(() => {
		db = new Database(":memory:");
		initDB(db);
	});

	/**
	 * @param {'github' | 'codeberg'} type
	 * @returns {Promise<any>}
	 */
	async function fetchAndParse(type) {
		const file = Bun.file(`./.http-cache/test/${type}.json`);
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

	it("should fetch GitHub, insert into zig_repos", async () => {
		const githubData = await fetchAndParse("github");
		zigReposInsert(db, [githubData]);
		const stmt = db.prepare(
			"SELECT * FROM zig_repos WHERE full_name = 'ziglang/zig'",
		);
		const result = stmt.get();
		expect(result).toBeDefined();
	});

	it("should fetch Codeberg, insert into zig_repos", async () => {
		const codebergData = await fetchAndParse("codeberg");
		zigReposInsert(db, [codebergData]);
		const stmt = db.prepare(
			"SELECT * FROM zig_repos WHERE full_name = 'codeberg:ziglings/exercises'",
		);
		const result = stmt.get();
		expect(result).toBeDefined();
		expect(result.full_name).toBe("codeberg:ziglings/exercises");
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
