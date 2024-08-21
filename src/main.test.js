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

const repos = [
	{ full_name: "ziglang/zig", default_branch: "master", platform: "github" },
	{ full_name: "ggerganov/ggml", default_branch: "master", platform: "github" },
	{ full_name: "fairyglade/ly", default_branch: "master", platform: "github" },
	{
		full_name: "dude_the_builder/zigstr",
		default_branch: "main",
		platform: "codeberg",
	},
	{
		full_name: "grayhatter/player",
		default_branch: "main",
		platform: "codeberg",
	},
	{
		full_name: "ziglings/exercises",
		default_branch: "main",
		platform: "codeberg",
	},
];

/**
 * @param {'github' | 'codeberg'} type
 * @param {string} full_name
 * @returns {string}
 */
const getURL = (type, full_name) => {
	if (type === "github") {
		return `https://api.github.com/repos/${full_name}`;
	} else if (type === "codeberg") {
		return `https://codeberg.org/api/v1/repos/${full_name}`;
	}
	return ""; // unreachable
};

/**
 * @param {'github' | 'codeberg'} type
 * @param {{full_name: string, default_branch: string}} repo
 * @returns {Promise<void>} */
const fetchWriteRepo = async (type, repo) => {
	const file = Bun.file(
		`./.http-cache/repo-${type}-${repo.full_name.replace("/", "-")}.json`,
	);
	if (file.size > 0) return;
	const url = getURL(type, repo.full_name);
	const res = await fetch(url, { headers: getHeaders(type) });
	const data = await res.json();
	await Bun.write(file, JSON.stringify(data));
};

/**
 * @param {'github' | 'codeberg'} type
 * @param {{full_name: string, default_branch: string}} repo
 * @returns {Promise<void>} */
const fetchWriteMetadata = async (type, repo) => {
	const zigFile = Bun.file(
		`./.http-cache/metadata-zig-${type}-${repo.full_name.replace("/", "-")}.json`,
	);
	const zonFile = Bun.file(
		`./.http-cache/metadata-zon-${type}-${repo.full_name.replace("/", "-")}.json`,
	);

	if (zigFile.size === 0) {
		const zigUrl = getZigBuildURL(type, repo.full_name, repo.default_branch);
		const zigResponse = await fetchMetadata(zigUrl);
		await Bun.write(zigFile, JSON.stringify(zigResponse));
	}

	if (zonFile.size === 0) {
		const zonUrl = getZigZonURL(type, repo.full_name, repo.default_branch);
		const zonResponse = await fetchMetadata(zonUrl);
		await Bun.write(zonFile, JSON.stringify(zonResponse));
	}
};

describe("Fetching and insertion", () => {
	let db;
	beforeAll(async () => {
		await Promise.all(
			repos.flatMap((repo) => [
				fetchWriteRepo(repo.platform, repo),
				fetchWriteMetadata(repo.platform, repo),
			]),
		);

		db = new Database("abcd.sqlite");
		initDB(db);
	});

	it("should fetch repos and insert into zig_repos", async () => {
		for (const repo of repos) {
			const schema = getSchemaRepo(repo.platform);
			const file = Bun.file(
				`./.http-cache/repo-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
			);
			let data = await file.json();

			upsertZigRepos(db, [schema.parse(data)]);
			const stmt = db.prepare("SELECT * FROM zig_repos WHERE full_name = ?");
			let result = stmt.get(
				repo.platform === "codeberg"
					? `codeberg:${repo.full_name}`
					: repo.full_name,
			);
			expect(result).toBeDefined();
			expect(result.full_name).toBe(
				repo.platform === "codeberg"
					? `codeberg:${repo.full_name}`
					: repo.full_name,
			);

			// check upsert
			data = { ...data, description: data.description + "!" };
			upsertZigRepos(db, [schema.parse(data)]);
			result = stmt.get(
				repo.platform === "codeberg"
					? `codeberg:${repo.full_name}`
					: repo.full_name,
			);
			expect(result).toBeDefined();
			expect(result.description).toBe(data.description);
		}
	});

	it("should fetch metadata and insert to db", async () => {
		for (const repo of repos) {
			const zigFile = Bun.file(
				`./.http-cache/metadata-zig-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
			);
			const zonFile = Bun.file(
				`./.http-cache/metadata-zon-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
			);
			const buildData = await zigFile.json();
			const zonData = await zonFile.json();
			expect(zonData.fetched_at).toBeGreaterThan(0);

			let parsed = null;
			if (zonData.status === 200) {
				try {
					parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
					expect(parsed).toBeDefined();
				} catch (e) {
					console.error(`Failed to parse ZON data for ${repo.full_name}: ${e}`);
				}
			}

			let metadata = {
				full_name:
					repo.platform === "codeberg"
						? `codeberg:${repo.full_name}`
						: repo.full_name,
				min_zig_version: parsed?.minimum_zig_version ?? null,
				build_zig_exists: buildData.status === 200,
				build_zig_zon_exists: zonData.status === 200,
				fetched_at: zonData.fetched_at,
			};
			upsertMetadata(db, [metadata]);

			const stmt = db.prepare(
				`SELECT * FROM zig_repo_metadata WHERE full_name = ?`,
			);
			let result = stmt.get(metadata.full_name);
			expect(result).toBeDefined();
			expect(result.full_name).toBe(metadata.full_name);
			expect(result.min_zig_version).toBe(metadata.min_zig_version);
			expect(Boolean(result.build_zig_exists)).toBe(buildData.status === 200);
			expect(Boolean(result.build_zig_zon_exists)).toBe(zonData.status === 200);
			expect(result.fetched_at).toBeGreaterThan(0);

			// check upsert
			metadata = { ...metadata, fetched_at: metadata.fetched_at + 1 };
			upsertMetadata(db, [metadata]);
			result = stmt.get(metadata.full_name);
			expect(result).toBeDefined();
			expect(result.fetched_at).toBe(metadata.fetched_at);
		}
	});

	it("should process dependencies and insert to db", async () => {
		for (const repo of repos) {
			const zonFile = Bun.file(
				`./.http-cache/metadata-zon-${repo.platform}-${repo.full_name.replace("/", "-")}.json`,
			);
			const zonData = await zonFile.json();
			if (zonData.status !== 200) continue;

			let parsed;
			try {
				parsed = SchemaZon.parse(JSON.parse(zon2json(zonData.content)));
				expect(parsed).toBeDefined();
			} catch (e) {
				console.error(`Failed to parse zon for ${repo.full_name}: ${e}`);
			}

			const full_name =
				repo.platform === "codeberg"
					? `codeberg:${repo.full_name}`
					: repo.full_name;
			const processedDeps = processDependencies(parsed, full_name);

			insertUrlDependencies(db, processedDeps.urlDeps);
			insertDependencies(db, processedDeps.deps);

			// verify dependencies insertion
			const depStmt = db.prepare(
				`SELECT * FROM zig_repo_dependencies WHERE full_name = ?`,
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

			// verify URL dependencies insertion
			const urlDepStmt = db.prepare(`
						SELECT *
						FROM url_dependencies
						WHERE hash IN (
							SELECT url_dependency_hash
							FROM zig_repo_dependencies
							WHERE full_name = ?
						)
					`);
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
		}
	});

	afterAll(() => {
		db.close();
		logger.flush();
	});
});
