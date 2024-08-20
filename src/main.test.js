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

	it("should fetch and insert zig_repos", async () => {
		const db = new Database(":memory:");
		initDB(db);
		const fetchPromises = ["codeberg", "github"].map(async (type) => {
			const url = getURL(type);
			const schema = getSchemaRepo(type);
			const res = await fetch(url, { headers: getHeaders(type) });
			const data = await res.json();
			return schema.parse(data);
		});
		const parsed = await Promise.all(fetchPromises);
		console.log(parsed);
		zigReposInsert(db, parsed);

		const stmt = db.prepare(`
			SELECT * FROM zig_repos;
		`);
		const result = stmt.all();
		console.log(result);
		expect(result).toBeDefined();
		expect(result.length).toBe(2);
		expect(result[0].full_name).toBe("codeberg:ziglings/exercises");
		expect(result[1].full_name).toBe("ziglang/zig");
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
