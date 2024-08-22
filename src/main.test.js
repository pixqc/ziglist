import { expect, describe, beforeAll, afterAll, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	getSchemaRepo,
	getHeaders,
	getTopRepoURL,
	insertUrlDependencies,
	upsertDependencies,
	initDB,
	upsertZigRepos,
	logger,
	getZigZonURL,
	fetchMetadata,
	SchemaZon,
	zon2json,
	getZigBuildURL,
	getAllRepoURL,
	upsertMetadata,
	getNextURL,
} from "./main.jsx";

/** @typedef {{full_name: string, default_branch: string, platform: 'github' | 'codeberg'}} Repo */

// biome-ignore format: off
/** @type {Array<Repo>} */
const repos = [
	{ full_name: "ziglang/zig", default_branch: "master", platform: "github" },
	{ full_name: "ggerganov/ggml", default_branch: "master", platform: "github" },
	{ full_name: "fairyglade/ly", default_branch: "master", platform: "github" },
	{ full_name: "dude_the_builder/zigstr", default_branch: "main", platform: "codeberg" },
	{ full_name: "grayhatter/player", default_branch: "main", platform: "codeberg" },
	{ full_name: "ziglings/exercises", default_branch: "main", platform: "codeberg" },
];
const CACHE_DIR = "./.http-cache";

/**
 * @param {'repo' | 'metadata-zig' | 'metadata-zon'} type
 * @param {Repo} repo
 * @returns {string}
 */
const getCacheFilename = (type, repo) => {
	return `${CACHE_DIR}/${type}-${repo.platform}-${repo.full_name.replace("/", "-")}.json`;
};

/**
 * @param {Repo} repo
 * @returns {string}
 */
const getURL = (repo) => {
	if (repo.platform === "github") {
		return `https://api.github.com/repos/${repo.full_name}`;
	} else if (repo.platform === "codeberg") {
		return `https://codeberg.org/api/v1/repos/${repo.full_name}`;
	}
	return ""; // unreachable
};

/**
 * @param {Repo} repo
 * @returns {Promise<void>} */
const cacheRepo = async (repo) => {
	const filename = getCacheFilename("repo", repo);
	const file = Bun.file(filename);
	if (file.size > 0) return;
	const url = getURL(repo);
	const res = await fetch(url, { headers: getHeaders(repo.platform) });
	const data = await res.json();
	await Bun.write(file, JSON.stringify(data));
};

/**
 * @param {Repo} repo
 * @returns {Promise<void>} */
const cacheMetadata = async (repo) => {
	const zigFilename = getCacheFilename("metadata-zig", repo);
	const zonFilename = getCacheFilename("metadata-zon", repo);
	const zigFile = Bun.file(zigFilename);
	const zonFile = Bun.file(zonFilename);
	if (zigFile.size === 0) {
		const zigUrl = getZigBuildURL(repo);
		const zigResponse = await fetchMetadata(zigUrl);
		await Bun.write(zigFile, JSON.stringify(zigResponse));
	}
	if (zonFile.size === 0) {
		const zonUrl = getZigZonURL(repo);
		const zonResponse = await fetchMetadata(zonUrl);
		await Bun.write(zonFile, JSON.stringify(zonResponse));
	}
};

describe("db inserts and reads", () => {
	let db;
	beforeAll(async () => {
		const promises = repos.flatMap((repo) => [
			cacheRepo(repo),
			cacheMetadata(repo),
		]);
		await Promise.all(promises);

		db = new Database(":memory:");
		initDB(db);
	});

	it("should not insert duplicate repos", async () => {
		for (const repo of repos) {
			const platform = repo.platform;
			const schema = getSchemaRepo(platform);
			const file = Bun.file(getCacheFilename("repo", repo));
			const data = await file.json();
			const parsed = schema.parse(data);

			upsertZigRepos(db, [parsed, parsed, parsed, parsed, parsed]);
			const stmt = db.prepare(
				`SELECT * 
					FROM zig_repos 
					WHERE full_name = ? AND platform = ?`,
			);
			const result = stmt.all(repo.full_name, repo.platform);
			expect(result).toHaveLength(1);
			expect(result[0].full_name).toBe(repo.full_name);
			expect(result[0].platform).toBe(repo.platform);
		}
	});

	it("should upsert repo properly", async () => {
		for (const repo of repos) {
			const platform = repo.platform;
			const schema = getSchemaRepo(platform);
			const file = Bun.file(getCacheFilename("repo", repo));
			let data = await file.json();
			data.description = data.description + "!";
			const parsed = schema.parse(data);

			upsertZigRepos(db, [parsed]);
			const stmt = db.prepare(
				`SELECT * 
					FROM zig_repos 
					WHERE full_name = ? AND platform = ?`,
			);
			const result = stmt.all(repo.full_name, repo.platform);
			expect(result).toHaveLength(1);
			expect(result[0].full_name).toBe(repo.full_name);
			expect(result[0].description).toEndWith("!");
		}
	});

	it("should not insert duplicate metadata", async () => {
		for (const repo of repos) {
			const zigFile = Bun.file(getCacheFilename("metadata-zig", repo));
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const buildData = await zigFile.json();
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			const buildExists = buildData.status === 200;

			const parsed = zonExists
				? SchemaZon.parse(JSON.parse(zon2json(zonData.content)))
				: null;

			const repoStmt = db.prepare(
				`SELECT id
					FROM zig_repos 
					WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			const metadata = {
				repo_id: repoId,
				min_zig_version: parsed?.minimum_zig_version ?? null,
				build_zig_exists: buildExists,
				build_zig_zon_exists: zonExists,
				fetched_at: zonData.fetched_at,
			};
			upsertMetadata(db, [metadata, metadata, metadata]);

			const stmt = db.prepare(
				`SELECT * 
					FROM zig_repo_metadata 
					WHERE repo_id = ?`,
			);
			const result = stmt.all(repoId);
			expect(result).toHaveLength(1);
			expect(result[0].repo_id).toBe(repoId);
			expect(result[0].min_zig_version).toBe(metadata.min_zig_version);
			expect(Boolean(result[0].build_zig_exists)).toBe(buildExists);
			expect(Boolean(result[0].build_zig_zon_exists)).toBe(zonExists);
			expect(result[0].fetched_at).toBeGreaterThan(0);
		}
	});

	it("should upsert metadata properly", async () => {
		for (const repo of repos) {
			const zigFile = Bun.file(getCacheFilename("metadata-zig", repo));
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const buildData = await zigFile.json();
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			const buildExists = buildData.status === 200;

			const repoStmt = db.prepare(
				`SELECT id
				FROM zig_repos 
				WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			const metadata = {
				repo_id: repoId,
				min_zig_version: "0.11.0",
				build_zig_exists: buildExists,
				build_zig_zon_exists: zonExists,
				fetched_at: zonData.fetched_at + 1,
			};
			upsertMetadata(db, [metadata]);

			const stmt = db.prepare(
				`SELECT * 
				FROM zig_repo_metadata 
				WHERE repo_id = ?`,
			);
			const result = stmt.all(repoId);
			expect(result).toHaveLength(1);
			expect(result[0].repo_id).toBe(repoId);
			expect(result[0].min_zig_version).toBe("0.11.0");
			expect(result[0].fetched_at).toBe(metadata.fetched_at);
		}
	});

	it("should process and insert dependencies correctly", async () => {
		for (const repo of repos) {
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			if (!zonExists) continue;
			const parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
			const repoStmt = db.prepare(
				`SELECT id FROM zig_repos WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			// intentionally duplicated
			for (let i = 0; i < 5; i++) {
				if (parsed.urlDeps.length > 0)
					insertUrlDependencies(db, parsed.urlDeps);
				if (parsed.deps.length > 0) upsertDependencies(db, parsed.deps, repoId);
			}

			const urlDepStmt = db.prepare(
				`SELECT *
				FROM url_dependencies
				WHERE hash IN (
					SELECT url_dependency_hash
					FROM zig_repo_dependencies
					WHERE repo_id = ?
				)`,
			);
			const urlDepResults = urlDepStmt.all(repoId);
			expect(urlDepResults).toHaveLength(parsed.urlDeps.length);
			for (const expectedUrlDep of parsed.urlDeps) {
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

			const depStmt = db.prepare(
				`SELECT *
				FROM zig_repo_dependencies
				WHERE repo_id = ?`,
			);
			const depResults = depStmt.all(repoId);
			expect(depResults).toHaveLength(parsed.deps.length);
			for (const expectedDep of parsed.deps) {
				const actualDep = depResults.find((d) => d.name === expectedDep.name);
				expect(actualDep).toBeDefined();
				expect(actualDep).toEqual(
					expect.objectContaining({
						repo_id: repoId,
						name: expectedDep.name,
						dependency_type: expectedDep.dependency_type,
						path: expectedDep.path,
						url_dependency_hash: expectedDep.url_dependency_hash,
					}),
				);
			}
		}
	});

	it("should match deps parsed data with joined database entries", async () => {
		for (const repo of repos) {
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const zonData = await zonFile.json();
			if (zonData.status !== 200) continue;
			const parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
			const repoStmt = db.prepare(
				`SELECT id
					FROM zig_repos
					WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			const joinStmt = db.prepare(
				`SELECT 
					r.*,
					GROUP_CONCAT(d.name) AS dependencies
				FROM zig_repos r
				LEFT JOIN zig_repo_dependencies d ON r.id = d.repo_id
				WHERE r.id = ?
				GROUP BY r.id
			`,
			);
			const joinResult = joinStmt.get(repoId);
			const dbSet = new Set(joinResult.dependencies.split(","));
			const parsedSet = new Set(parsed.deps.map((d) => d.name));
			expect(dbSet).toEqual(parsedSet);
		}
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});

/**
 * @param {'github' | 'codeberg'} platform
 * @param {number} pages
 * @returns {Promise<void>}
 */
const cacheTopRepos = async (platform, pages) => {
	let url = getTopRepoURL(platform);
	for (let i = 1; i <= pages; i++) {
		const filename = `./.http-cache/${platform}-top-${i}.json`;
		const file = Bun.file(filename);
		if (file.size > 0) continue; // Skip if file exists
		const response = await fetch(url, { headers: getHeaders(platform) });
		const data = await response.json();
		await Bun.write(file, JSON.stringify(data));
		// @ts-ignore - wont be undefined
		url = getNextURL(response);
	}
};

describe("fetches", () => {
	let db;
	beforeAll(async () => {
		await Promise.all([
			cacheTopRepos("github", 2),
			cacheTopRepos("codeberg", 2),
		]);

		db = new Database(":memory:");
		initDB(db);
	});

	it("should parse top github repos", async () => {
		["1", "2"].forEach(async (page) => {
			const filename = `./.http-cache/github-top-${page}.json`;
			const file = Bun.file(filename);
			const data = await file.json();
			expect(data.items).toHaveLength(100);
			const schema = getSchemaRepo("github");
			for (const item of data.items) {
				const tryParsed = schema.safeParse(item);
				if (!tryParsed.success) console.error(tryParsed.error);
				expect(tryParsed.success).toBe(true);
			}
		});
	});

	it("should parse top codeberg repos", async () => {
		["1", "2"].forEach(async (page) => {
			const filename = `./.http-cache/codeberg-top-${page}.json`;
			const file = Bun.file(filename);
			const data = await file.json();
			expect(data.data).toHaveLength(50);
			const schema = getSchemaRepo("codeberg");
			for (const item of data.data) {
				const tryParsed = schema.safeParse(item);
				if (!tryParsed.success) console.error(tryParsed.error);
				expect(tryParsed.success).toBe(true);
			}
		});
	});

	it("should have a generator that loops", async () => {
		// generate 100 times, make sure "2015-07-04" happens at least twice
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
