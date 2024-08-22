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
	upsertMetadata,
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
const fetchWriteRepo = async (repo) => {
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
const fetchWriteMetadata = async (repo) => {
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

describe("Fetching and insertion", () => {
	let db;
	beforeAll(async () => {
		await Promise.all(
			repos.flatMap((repo) => [fetchWriteRepo(repo), fetchWriteMetadata(repo)]),
		);

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

			upsertZigRepos(db, [parsed, parsed, parsed]);
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

			const parsed =
				zonData.status === 200
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
				build_zig_exists: buildData.status === 200,
				build_zig_zon_exists: zonData.status === 200,
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
			expect(Boolean(result[0].build_zig_exists)).toBe(
				buildData.status === 200,
			);
			expect(Boolean(result[0].build_zig_zon_exists)).toBe(
				zonData.status === 200,
			);
			expect(result[0].fetched_at).toBeGreaterThan(0);

			// expect(result).toBeDefined();
			// expect(result.repo_id).toBe(repoId);
			// expect(result.min_zig_version).toBe(metadata.min_zig_version);
			// expect(Boolean(result.build_zig_exists)).toBe(buildData.status === 200);
			// expect(Boolean(result.build_zig_zon_exists)).toBe(zonData.status === 200);
			// expect(result.fetched_at).toBeGreaterThan(0);
			// let result = stmt.get(metadata.full_name);
			// expect(result).toBeDefined();
			// expect(result.full_name).toBe(metadata.full_name);
			// expect(result.min_zig_version).toBe(metadata.min_zig_version);
			// expect(Boolean(result.build_zig_exists)).toBe(buildData.status === 200);
			// expect(Boolean(result.build_zig_zon_exists)).toBe(zonData.status === 200);
			// expect(result.fetched_at).toBeGreaterThan(0);
			//
			// // Check upsert and ensure no duplication
			// metadata = { ...metadata, fetched_at: metadata.fetched_at + 1 };
			// upsertMetadata(db, [metadata]);
			// result = stmt.get(metadata.full_name);
			// expect(result).toBeDefined();
			// expect(result.fetched_at).toBe(metadata.fetched_at);
			//
			// // Check for duplication
			// const countStmt = db.prepare(
			// 	`SELECT COUNT(*) as count FROM zig_repo_metadata WHERE full_name = ?`,
			// );
			// const countResult = countStmt.get(metadata.full_name);
			// expect(countResult.count).toBe(1);
		}
	});

	// it("should fetch metadata and insert to db", async () => {
	// 	for (const repo of repos) {
	// 		const zigFile = Bun.file(
	// 			`./.http-cache/metadata-zig-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
	// 		);
	// 		const zonFile = Bun.file(
	// 			`./.http-cache/metadata-zon-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
	// 		);
	// 		const buildData = await zigFile.json();
	// 		const zonData = await zonFile.json();
	// 		expect(zonData.fetched_at).toBeGreaterThan(0);
	//
	// 		let parsed = null;
	// 		if (zonData.status === 200) {
	// 			try {
	// 				parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
	// 				expect(parsed).toBeDefined();
	// 			} catch (e) {
	// 				console.error(`Failed to parse ZON data for ${repo.full_name}: ${e}`);
	// 			}
	// 		}
	//
	// 		let metadata = {
	// 			full_name: `${repo.platform}:${repo.full_name}`,
	// 			platform: repo.platform,
	// 			min_zig_version: parsed?.minimum_zig_version ?? null,
	// 			build_zig_exists: buildData.status === 200,
	// 			build_zig_zon_exists: zonData.status === 200,
	// 			fetched_at: zonData.fetched_at,
	// 		};
	// 		upsertMetadata(db, [metadata]);
	//
	// 		const stmt = db.prepare(
	// 			`SELECT * FROM zig_repo_metadata WHERE full_name = ?`,
	// 		);
	// 		let result = stmt.get(metadata.full_name);
	// 		expect(result).toBeDefined();
	// 		expect(result.full_name).toBe(metadata.full_name);
	// 		expect(result.min_zig_version).toBe(metadata.min_zig_version);
	// 		expect(Boolean(result.build_zig_exists)).toBe(buildData.status === 200);
	// 		expect(Boolean(result.build_zig_zon_exists)).toBe(zonData.status === 200);
	// 		expect(result.fetched_at).toBeGreaterThan(0);
	//
	// 		// check upsert
	// 		metadata = { ...metadata, fetched_at: metadata.fetched_at + 1 };
	// 		upsertMetadata(db, [metadata]);
	// 		result = stmt.get(metadata.full_name);
	// 		expect(result).toBeDefined();
	// 		expect(result.fetched_at).toBe(metadata.fetched_at);
	// 	}
	// });

	//
	// it("should process dependencies and insert to db", async () => {
	// 	for (const repo of repos) {
	// 		const zonFile = Bun.file(
	// 			`./.http-cache/metadata-zon-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
	// 		);
	// 		const zonData = await zonFile.json();
	// 		if (zonData.status !== 200) continue;
	//
	// 		let parsed;
	// 		try {
	// 			parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
	// 			expect(parsed).toBeDefined();
	// 		} catch (e) {
	// 			console.error(`Failed to parse zon for ${repo.full_name}: ${e}`);
	// 		}
	//
	// 		const full_name =
	// 			repo.platform === "codeberg"
	// 				? `codeberg:${repo.full_name}`
	// 				: repo.full_name;
	// 		const processedDeps = processDependencies(full_name, parsed);
	//
	// 		insertUrlDependencies(db, processedDeps.urlDeps);
	// 		insertDependencies(db, processedDeps.deps);
	//
	// 		// verify dependencies insertion
	// 		const depStmt = db.prepare(
	// 			`SELECT * FROM zig_repo_dependencies WHERE full_name = ?`,
	// 		);
	// 		const depResults = depStmt.all(full_name);
	// 		expect(depResults).toHaveLength(processedDeps.deps.length);
	//
	// 		for (const expectedDep of processedDeps.deps) {
	// 			const actualDep = depResults.find((d) => d.name === expectedDep.name);
	// 			expect(actualDep).toBeDefined();
	// 			expect(actualDep).toEqual(
	// 				expect.objectContaining({
	// 					full_name: expectedDep.full_name,
	// 					name: expectedDep.name,
	// 					dependency_type: expectedDep.dependency_type,
	// 					path: expectedDep.path,
	// 					url_dependency_hash: expectedDep.url_dependency_hash,
	// 				}),
	// 			);
	// 		}
	//
	// 		// verify URL dependencies insertion
	// 		const urlDepStmt = db.prepare(`
	// 			SELECT *
	// 			FROM url_dependencies
	// 			WHERE hash IN (
	// 				SELECT url_dependency_hash
	// 				FROM zig_repo_dependencies
	// 				WHERE full_name = ?
	// 			)
	// 		`);
	// 		const urlDepResults = urlDepStmt.all(full_name);
	// 		expect(urlDepResults).toHaveLength(processedDeps.urlDeps.length);
	//
	// 		for (const expectedUrlDep of processedDeps.urlDeps) {
	// 			const actualUrlDep = urlDepResults.find(
	// 				(d) => d.hash === expectedUrlDep.hash,
	// 			);
	// 			expect(actualUrlDep).toBeDefined();
	// 			expect(actualUrlDep).toEqual(
	// 				expect.objectContaining({
	// 					hash: expectedUrlDep.hash,
	// 					name: expectedUrlDep.name,
	// 					url: expectedUrlDep.url,
	// 				}),
	// 			);
	// 		}
	// 	}
	// });

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
