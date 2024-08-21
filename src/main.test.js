import { expect, describe, beforeAll, afterAll, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	getSchemaRepo,
	getHeaders,
	insertUrlDependencies,
	insertDependencies,
	initDB,
	processDependencies,
	upsertZigRepos,
	logger,
	getZigZonURL,
	fetchMetadata,
	SchemaZon,
	zon2json,
	getZigBuildURL,
	updateMetadata,
} from "./main.jsx";

// TODO:
// - shouldn't dupe on multiple inserts

/**
 * @param {'github' | 'codeberg'} type
 * @returns {{full_name: string, default_branch: string}}
 */
const getFullName = (type) => {
	if (type === "github") {
		// because the zon has both path and url, good for testing
		return { full_name: "Copper280z/ZigFOC", default_branch: "main" };
	} else if (type === "codeberg") {
		return { full_name: "ziglings/exercises", default_branch: "main" };
	}
	return { full_name: "", default_branch: "" }; //unreachable
};

/**
 * @param {'github' | 'codeberg'} type
 * @returns {string}
 */
const getURL = (type) => {
	const { full_name } = getFullName(type);
	if (type === "github") {
		return `https://api.github.com/repos/${full_name}`;
	} else if (type === "codeberg") {
		return `https://codeberg.org/api/v1/repos/${full_name}`;
	}
	return ""; // unreachable
};

describe("Fetching and insertion", () => {
	let db;
	beforeAll(() => {
		db = new Database("test.sqlite");
		initDB(db);
	});

	it("should fetch GitHub repo, insert into zig_repos", async () => {
		const type = "github";
		const { full_name } = getFullName(type);
		const schema = getSchemaRepo(type);
		const url = getURL(type);
		const res = await fetch(url, { headers: getHeaders(type) });
		const data = await res.json();
		upsertZigRepos(db, [schema.parse(data)]);
		const stmt = db.prepare("SELECT * FROM zig_repos WHERE full_name = ?");
		const result = stmt.get(full_name);
		expect(result).toBeDefined();
		expect(result.full_name).toBe(full_name);

		const modified = { ...data, stargazers_count: 33 };
		upsertZigRepos(db, [schema.parse(modified)]);
		const result2 = stmt.get(full_name);
		expect(result2).toBeDefined();
		expect(result2.full_name).toBe(full_name);
		expect(result2.stars).toBe(33);
	});

	it("should fetch Codeberg repo, insert into zig_repos", async () => {
		const type = "codeberg";
		const { full_name } = getFullName(type);
		const schema = getSchemaRepo(type);
		const url = getURL(type);
		const res = await fetch(url, { headers: getHeaders(type) });
		const data = await res.json();
		upsertZigRepos(db, [schema.parse(data)]);
		const stmt = db.prepare("SELECT * FROM zig_repos WHERE full_name = ?");
		const result = stmt.get(`codeberg:${full_name}`);
		expect(result).toBeDefined();
		expect(result.full_name).toBe(`codeberg:${full_name}`);
	});

	it("should fetch github metadata and insert to db", async () => {
		const type = "github";
		const { full_name, default_branch } = getFullName(type);
		const [zonData, buildData] = await Promise.all([
			fetchMetadata(getZigZonURL(type, full_name, default_branch)),
			fetchMetadata(getZigBuildURL(type, full_name, default_branch)),
		]);

		expect(zonData.status).toBe(200);
		expect(buildData.status).toBe(200);
		expect(zonData.fetched_at).toBeGreaterThan(0);
		let parsed;
		try {
			parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
			expect(parsed).toBeDefined();
		} catch (e) {
			throw e;
		}

		const metadata = {
			full_name: full_name,
			min_zig_version: parsed.minimum_zig_version ?? null,
			build_zig_exists: buildData.status === 200,
			build_zig_zon_exists: zonData.status === 200,
			fetched_at: zonData.fetched_at,
		};
		updateMetadata(db, [metadata]);
		const processedDeps = processDependencies(parsed, full_name);
		insertUrlDependencies(db, processedDeps.urlDeps);
		insertDependencies(db, processedDeps.deps);

		const stmt = db.prepare(
			`SELECT *
			FROM zig_repo_metadata
			WHERE full_name = ?`,
		);
		const result = stmt.get(full_name);
		expect(result).toBeDefined();
		expect(result.full_name).toBe(full_name);
		if (parsed.minimum_zig_version === undefined) {
			expect(result.min_zig_version).toBeNull();
		} else {
			expect(result.min_zig_version).toBe(parsed.minimum_zig_version);
		}
		expect(Boolean(result.build_zig_exists)).toBe(buildData.status === 200);
		expect(Boolean(result.build_zig_zon_exists)).toBe(zonData.status === 200);
		expect(result.fetched_at).toBeGreaterThan(0);

		const depStmt = db.prepare(
			`SELECT *
			FROM zig_repo_dependencies
			WHERE full_name = ?`,
		);
		const depResults = depStmt.all(full_name);
		expect(depResults).toHaveLength(processedDeps.deps.length);

		for (const expectedDep of processedDeps.deps) {
			const actualDep = depResults.find((d) => d.name === expectedDep.name);
			expect(actualDep).toBeDefined();
			expect(actualDep).toEqual(
				expect.objectContaining({
					full_name: expectedDep.full_name,
					name: expectedDep.name,
					dependency_type: expectedDep.dependency_type,
					path: expectedDep.path,
					url_dependency_hash: expectedDep.url_dependency_hash,
				}),
			);
		}

		const urlDepStmt = db.prepare(`
			SELECT * 
			FROM url_dependencies 
			WHERE hash IN (
				SELECT url_dependency_hash 
				FROM zig_repo_dependencies 
				WHERE full_name = ?`);
		const urlDepResults = urlDepStmt.all(full_name);
		expect(urlDepResults).toHaveLength(processedDeps.urlDeps.length);

		for (const expectedUrlDep of processedDeps.urlDeps) {
			const actualUrlDep = urlDepResults.find(
				(d) => d.hash === expectedUrlDep.hash,
			);
			expect(actualUrlDep).toBeDefined();
			expect(actualUrlDep).toEqual(
				expect.objectContaining({
					hash: expectedUrlDep.hash,
					name: expectedUrlDep.name,
					url: expectedUrlDep.url,
				}),
			);
		}
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
