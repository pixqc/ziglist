import { expect, describe, beforeAll, afterAll, test } from "bun:test";
import { Glob } from "bun";
import { Database } from "bun:sqlite";
import {
	headers,
	extractZon,
	getTopRepoURL,
	insertUrlDependencies,
	upsertDependencies,
	initDB,
	upsertZigRepos,
	logger,
	getZigZonURL,
	fetchMetadata,
	zon2json,
	getZigBuildURL,
	getAllRepoURL,
	upsertMetadata,
	getNextURL,
	dateGenerator,
	repoExtractors,
} from "./main.js";

const CACHE_DIR = "./.http-cache";
const DB_NAME = ":memory:";

// TODO:
// - fts
// - fetch -> insert -> read (server's query) should be in good state

/** @typedef {{full_name: string, default_branch: string, platform: 'github' | 'codeberg'}} RepoName */

// biome-ignore format: off
/** @type {Array<RepoName>} */
const repos = [
	{ full_name: "ziglang/zig", default_branch: "master", platform: "github" },
	{ full_name: "ggerganov/ggml", default_branch: "master", platform: "github" },
	{ full_name: "fairyglade/ly", default_branch: "master", platform: "github" },
	{ full_name: "Hejsil/zig-clap", default_branch: "master", platform: "github" },
	{ full_name: "dude_the_builder/zigstr", default_branch: "main", platform: "codeberg" },
	{ full_name: "grayhatter/player", default_branch: "main", platform: "codeberg" },
	{ full_name: "ziglings/exercises", default_branch: "main", platform: "codeberg" },
];

/**
 * @param {'repo' | 'metadata-zig' | 'metadata-zon'} type
 * @param {RepoName} repo
 * @returns {string}
 */
const getCacheFilename = (type, repo) => {
	return `${CACHE_DIR}/${type}-${repo.platform}-${repo.full_name.replace("/", "-")}.json`;
};

/**
 * @param {RepoName} repo
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
 * @param {RepoName} repo
 * @returns {Promise<void>} */
const cacheRepo = async (repo) => {
	const filename = getCacheFilename("repo", repo);
	const file = Bun.file(filename);
	if (file.size > 0) return;
	const url = getURL(repo);
	const res = await fetch(url, { headers: headers[repo.platform] });
	const data = await res.json();
	await Bun.write(file, JSON.stringify(data));
};

/**
 * @param {RepoName} repo
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

		db = new Database(DB_NAME);
		initDB(db);
	});

	test("multiple repo inserts should not duplicate", async () => {
		for (const repo of repos) {
			const file = Bun.file(getCacheFilename("repo", repo));
			const data = await file.json();
			const extractor = repoExtractors[repo.platform];
			const parsed = extractor(data);

			upsertZigRepos(db, [parsed, parsed, parsed, parsed, parsed]);
			const stmt = db.prepare(
				`SELECT * 
					FROM repos 
					WHERE full_name = ? AND platform = ?`,
			);

			const result = stmt.all(repo.full_name, repo.platform);
			expect(result).toHaveLength(1);
			expect(result[0].full_name).toBe(parsed.full_name);
			expect(result[0].platform).toBe(parsed.platform);
			expect(result[0].name).toBe(parsed.name);
			expect(result[0].default_branch).toBe(parsed.default_branch);
			expect(result[0].owner).toBe(parsed.owner);
			expect(result[0].created_at).toBe(parsed.created_at);
			expect(result[0].updated_at).toBe(parsed.updated_at);
			expect(result[0].pushed_at).toBe(parsed.pushed_at);
			expect(result[0].description).toBe(parsed.description);
			expect(result[0].homepage).toBe(parsed.homepage);
			expect(result[0].license).toBe(parsed.license);
			expect(result[0].language).toBe(parsed.language);
			expect(result[0].stars).toBe(parsed.stars);
			expect(result[0].forks).toBe(parsed.forks);
			expect(Boolean(result[0].is_fork)).toBe(parsed.is_fork);
			expect(Boolean(result[0].is_archived)).toBe(parsed.is_archived);
		}
	});

	test("repo upsert should update properly", async () => {
		for (const repo of repos) {
			const file = Bun.file(getCacheFilename("repo", repo));
			const data = await file.json();
			const extractor = repoExtractors[repo.platform];
			let parsed = extractor(data);
			parsed.description = parsed.description + "!";
			upsertZigRepos(db, [parsed]);
			const stmt = db.prepare(
				`SELECT * 
					FROM repos 
					WHERE full_name = ? AND platform = ?`,
			);
			const result = stmt.all(repo.full_name, repo.platform);
			expect(result).toHaveLength(1);
			expect(result[0].full_name).toBe(parsed.full_name);
			expect(result[0].platform).toBe(parsed.platform);
			expect(result[0].name).toBe(parsed.name);
			expect(result[0].default_branch).toBe(parsed.default_branch);
			expect(result[0].owner).toBe(parsed.owner);
			expect(result[0].created_at).toBe(parsed.created_at);
			expect(result[0].updated_at).toBe(parsed.updated_at);
			expect(result[0].pushed_at).toBe(parsed.pushed_at);
			expect(result[0].description).toBe(parsed.description);
			expect(result[0].description).toEndWith("!");
			expect(result[0].homepage).toBe(parsed.homepage);
			expect(result[0].license).toBe(parsed.license);
			expect(result[0].language).toBe(parsed.language);
			expect(result[0].stars).toBe(parsed.stars);
			expect(result[0].forks).toBe(parsed.forks);
			expect(Boolean(result[0].is_fork)).toBe(parsed.is_fork);
			expect(Boolean(result[0].is_archived)).toBe(parsed.is_archived);
		}
	});

	test("multiple metadata inserts should not duplicate", async () => {
		for (const repo of repos) {
			const zigFile = Bun.file(getCacheFilename("metadata-zig", repo));
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const buildData = await zigFile.json();
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			const buildExists = buildData.status === 200;
			if (!zonExists) continue;
			const parsed = extractZon(JSON.parse(zon2json(zonData.content)));

			const repoStmt = db.prepare(
				`SELECT id
					FROM repos 
					WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			const metadata = {
				repo_id: repoId,
				min_zig_version: parsed.minimum_zig_version,
				build_zig_exists: buildExists,
				build_zig_zon_exists: zonExists,
				fetched_at: zonData.fetched_at,
			};
			upsertMetadata(db, [metadata, metadata, metadata]);

			const stmt = db.prepare(
				`SELECT * 
					FROM repo_metadata 
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

	test("metadata upsert should update properly", async () => {
		for (const repo of repos) {
			const zigFile = Bun.file(getCacheFilename("metadata-zig", repo));
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const buildData = await zigFile.json();
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			const buildExists = buildData.status === 200;

			const repoStmt = db.prepare(
				`SELECT id
				FROM repos
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
				FROM repo_metadata
				WHERE repo_id = ?`,
			);
			const result = stmt.all(repoId);
			expect(result).toHaveLength(1);
			expect(result[0].repo_id).toBe(repoId);
			expect(result[0].min_zig_version).toBe("0.11.0");
			expect(result[0].fetched_at).toBe(zonData.fetched_at + 1);
		}
	});

	test("extracted zon should match database entries", async () => {
		for (const repo of repos) {
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const zonData = await zonFile.json();
			const zonExists = zonData.status === 200;
			if (!zonExists) continue;
			const parsed = extractZon(JSON.parse(zon2json(zonData.content)));
			const repoStmt = db.prepare(
				`SELECT id FROM repos WHERE full_name = ? AND platform = ?`,
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
					FROM repo_dependencies
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
				FROM repo_dependencies
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

	test("deps parsed data should match database entries", async () => {
		for (const repo of repos) {
			const zonFile = Bun.file(getCacheFilename("metadata-zon", repo));
			const zonData = await zonFile.json();
			if (zonData.status !== 200) continue;
			const parsed = extractZon(JSON.parse(zon2json(zonData.content)));
			const repoStmt = db.prepare(
				`SELECT id
					FROM repos
					WHERE full_name = ? AND platform = ?`,
			);
			const repoResult = repoStmt.get(repo.full_name, repo.platform);
			expect(repoResult).toBeDefined();
			const repoId = repoResult.id;

			const joinStmt = db.prepare(
				`SELECT
					r.*,
					GROUP_CONCAT(d.name) AS dependencies
				FROM repos r
				LEFT JOIN repo_dependencies d ON r.id = d.repo_id
				WHERE r.id = ?
				GROUP BY r.id
			`,
			);
			const joinResult = joinStmt.get(repoId);
			const dbSet =
				joinResult.dependencies == null
					? new Set()
					: new Set(joinResult.dependencies.split(","));
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
		if (file.size > 0) continue;
		const response = await fetch(url, { headers: headers[platform] });
		const data = await response.json();
		await Bun.write(file, JSON.stringify(data));
		// @ts-ignore - wont be undefined
		url = getNextURL(response);
	}
};

/**
 * only the first page, go through all date ranges, github only
 * FIXME: refetches on --rerun-each 5
 *
 * @param {'github' | 'codeberg'} platform
 * @returns {Promise<void>}
 */
const cacheAllRepos = async (platform) => {
	let idx = 1;
	while (true) {
		const filename = `./.http-cache/${platform}-all-${idx}.json`;
		const file = Bun.file(filename);
		if (file.size > 0) {
			idx++;
			continue;
		}
		const url = getAllRepoURL(platform);
		if (idx !== 1 && url.includes("2015-07-04")) break;
		const response = await fetch(url, { headers: headers[platform] });
		const data = await response.json();
		await Bun.write(Bun.file(filename), JSON.stringify(data));
	}
};

describe("fetches", () => {
	let db;
	beforeAll(async () => {
		await Promise.all([
			cacheTopRepos("github", 2),
			cacheTopRepos("codeberg", 2),
			cacheAllRepos("github"),
		]);

		db = new Database(DB_NAME);
		initDB(db);
	});

	test("top github repos should parse", async () => {
		["1", "2"].forEach(async (page) => {
			const filename = `./.http-cache/github-top-${page}.json`;
			const file = Bun.file(filename);
			const data = await file.json();
			expect(data.items).toHaveLength(100);
			const extractor = repoExtractors["github"];
			for (const item of data.items) expect(extractor(item)).toBeDefined();
		});
	});

	test("top codeberg repos should parse", async () => {
		["1", "2"].forEach(async (page) => {
			const filename = `./.http-cache/codeberg-top-${page}.json`;
			const file = Bun.file(filename);
			const data = await file.json();
			expect(data.data).toHaveLength(50);
			const extractor = repoExtractors["codeberg"];
			for (const item of data.data) expect(extractor(item)).toBeDefined();
		});
	});

	test("fetch all should have items below 1k", async () => {
		const glob = new Glob("./.http-cache/github-all-*.json");
		for await (const filename of glob.scan({ dot: true })) {
			const file = Bun.file(filename);
			const data = await file.json();
			expect(data.total_count).toBeLessThan(1000);
		}
	});

	test("generator should loop date range", async () => {
		const starts = [];
		for (let i = 0; i < 100; i++) {
			const { start } = dateGenerator().next().value;
			starts.push(start.toISOString().slice(0, 10));
		}
		const countOccurrences = (date) => starts.filter((d) => d === date).length;
		expect(countOccurrences("2015-07-04")).toBeGreaterThanOrEqual(2);
		expect(countOccurrences("2024-01-20")).toBeGreaterThanOrEqual(2);
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
