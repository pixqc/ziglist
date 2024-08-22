import { z } from "zod";
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

// TODO:
// - are there more fields i need to add? just in case
// - the github all url generator can be hardcoded, no need to addWeeks

/** @typedef {{full_name: string, default_branch: string, platform: 'github' | 'codeberg'}} Repo */
/** @typedef {('trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal')} LogLevel */

// ----------------------------------------------------------------------------
// utils

/**
 * @returns {{
 *   trace: (message: string, data?: any) => void,
 *   debug: (message: string, data?: any) => void,
 *   info: (message: string, data?: any) => void,
 *   warn: (message: string, data?: any) => void,
 *   error: (message: string, data?: any) => void,
 *   fatal: (message: string, data?: any) => void,
 *   flush: () => Promise<void>
 * }} A logger object with methods for each log level and a flush method.
 */
export const createLogger = () => {
	/** @type {string[]} */
	let buffer = [];

	const LOG_MAP = {
		trace: 10,
		debug: 20,
		info: 30,
		warn: 40,
		error: 50,
		fatal: 60,
	};

	/**
	 * Logs a message with a log level and optional data.
	 * @param {LogLevel} level - Log level.
	 * @param {string} message - Log message.
	 * @param {any} [data] - Additional data to log (optional).
	 * @returns {void}
	 */
	const log = (level, message, data) => {
		const logEntry = {
			timestamp: new Date().toISOString(),
			level: LOG_MAP[level],
			message,
			data,
		};

		buffer.push(JSON.stringify(logEntry));
	};

	return {
		trace: (message, data) => log("trace", message, data),
		debug: (message, data) => log("debug", message, data),
		info: (message, data) => log("info", message, data),
		warn: (message, data) => log("warn", message, data),
		error: (message, data) => log("error", message, data),
		fatal: (message, data) => log("fatal", message, data),

		async flush() {
			if (buffer.length === 0) return;
			const bufStr = buffer.join("\n") + "\n";
			appendFileSync("log.txt", bufStr);
			buffer = [];
		},
	};
};

export const logger = createLogger();

/**
 * A wise man once said:
 * Runtime crashes are better than bugs.
 * Compile errors are better than runtime crashes.
 *
 * @param {string} message - Error message to log.
 * @param {Object} [data] - Additional data to log (optional).
 */
const fatal = (message, data) => {
	logger.fatal(message, data);
	logger.flush();
	process.exit(1);
};

/**
 * @param {string} dateString
 * @returns {number}
 */
const dateToUnix = (dateString) =>
	Math.floor(new Date(dateString).getTime() / 1000);

/**
 * https://github.com/ziglang/zig/blob/a931bfada5e358ace980b2f8fbc50ce424ced526/doc/build.zig.zon.md
 *
 * @param {string} zon - raw zig struct (build.zig.zon)
 * @returns {string} - string parseable by JSON.parse
 */
export const zon2json = (zon) => {
	return zon
		.replace(/(?<!:)\/\/.*$/gm, "") // Remove comments
		.replace(/\.\{""}/g, ".{}") // Handle empty objects
		.replace(/\.{/g, "{") // Replace leading dots before curly braces
		.replace(/\.@"([^"]+)"?\s*=\s*/g, '"$1": ') // Handle .@"key" = value
		.replace(/\.(\w+)\s*=\s*/g, '"$1": ') // Handle .key = value
		.replace(/("paths"\s*:\s*){([^}]*)}/g, "$1[$2]") // Convert paths to array
		.replace(/,(\s*[}\]])/g, "$1") // Remove trailing commas
		.replace(/"url"\s*:\s*"([^"]+)"/g, (_, p1) => {
			// Special handling for URL to preserve '?' and '#'
			return `"url": "${p1.replace(/"/g, '\\"')}"`;
		});
};

// ----------------------------------------------------------------------------
// queries

/**
 * @param {Database} conn
 * @returns {void}
 */
export const initDB = (conn) => {
	conn.exec(`PRAGMA journal_mode = WAL;`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS zig_repos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		full_name TEXT NOT NULL,
		platform TEXT NOT NULL,
		name TEXT,
		owner TEXT,
		description TEXT NULL,
		homepage TEXT NULL,
		license TEXT NULL,
		created_at INTEGER,
		updated_at INTEGER,
		pushed_at INTEGER,
		stars INTEGER,
		forks INTEGER,
		is_fork BOOLEAN,
		is_archived BOOLEAN,
		default_branch TEXT,
		language TEXT,
		UNIQUE (platform, full_name)
	);
	CREATE TABLE IF NOT EXISTS zig_repo_metadata (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id INTEGER NOT NULL, 
		min_zig_version TEXT,
		build_zig_exists BOOLEAN NULL,
		build_zig_zon_exists BOOLEAN NULL,
		fetched_at INTEGER NULL,
		FOREIGN KEY (repo_id) REFERENCES zig_repos(id) 
		ON DELETE CASCADE, 
		UNIQUE(repo_id) 
	);
	CREATE TABLE IF NOT EXISTS url_dependencies (
		hash TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		url TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS zig_repo_dependencies (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		dependency_type TEXT CHECK(dependency_type IN ('url', 'path')) NOT NULL,
		path TEXT,
		url_dependency_hash TEXT,
		FOREIGN KEY (repo_id) REFERENCES zig_repos(id) 
		ON DELETE CASCADE,
		FOREIGN KEY (url_dependency_hash) REFERENCES url_dependencies (hash),
		UNIQUE(repo_id, name, dependency_type, path),
		UNIQUE(repo_id, name, dependency_type, url_dependency_hash)
	);
`);
};

/**
 * @typedef {Object} RepoMetadata
 * @property {number} repo_id
 * @property {string|null} min_zig_version
 * @property {boolean} build_zig_exists
 * @property {boolean} build_zig_zon_exists
 * @property {number} fetched_at
 */

/**
 * @param {Database} conn
 * @param {RepoMetadata[]} parsed
 */
export const upsertMetadata = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT INTO zig_repo_metadata (
			repo_id,
			min_zig_version,
			build_zig_exists,
			build_zig_zon_exists,
			fetched_at
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(repo_id) DO UPDATE SET
			min_zig_version = excluded.min_zig_version,
			build_zig_exists = excluded.build_zig_exists,
			build_zig_zon_exists = excluded.build_zig_zon_exists,
			fetched_at = excluded.fetched_at
	`);
	try {
		const bulkUpdate = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(
					row.repo_id,
					row.min_zig_version ?? null,
					row.build_zig_exists,
					row.build_zig_zon_exists,
					row.fetched_at,
				);
			}
		});
		bulkUpdate(parsed);
		logger.info(`db - upsertMetadata - len ${parsed.length}`);
	} catch (e) {
		logger.error(`db - upsertMetadata - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};

/**
 * @param {Database} conn
 * @param {z.infer<ReturnType<typeof getSchemaRepo>>[]} parsed
 */
export const upsertZigRepos = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT OR REPLACE INTO zig_repos (
			platform, full_name, name, owner, description, homepage, license, 
			created_at, updated_at, pushed_at, stars, forks, 
			is_fork, is_archived, default_branch, language
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});
		const rows = parsed.map((item) => [
			item.platform,
			item.full_name,
			item.name,
			item.owner,
			item.description,
			item.homepage,
			item.license,
			item.created_at,
			item.updated_at,
			item.pushed_at,
			item.stars,
			item.forks,
			item.is_fork,
			item.is_archived,
			item.default_branch,
			item.language,
		]);
		upsertMany(rows);
		logger.info(`db - upsertZigRepos - len ${rows.length}`);
	} catch (e) {
		logger.error(`db - upsertZigRepos - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};

// ----------------------------------------------------------------------------
// schemas

const SchemaRepoBase = z.object({
	name: z.string(),
	full_name: z.string(),
	owner: z.object({ login: z.string() }),
	description: z.string().nullish(),
	language: z.string().nullish(),
	fork: z.boolean(),
	forks_count: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	license: z.object({ spdx_id: z.string() }).nullish(),
	homepage: z.string().nullish(),
	default_branch: z.string(),
	stargazers_count: z.number().nullish(),
	stars_count: z.number().nullish(),
	pushed_at: z.string().nullish(),
	archived: z.boolean(),
});

/**
 * @param {z.infer<typeof SchemaRepoBase>} data
 * @param {'github' | 'codeberg'} platform
 */
const transformRepo = (data, platform) => ({
	platform,
	name: data.name,
	full_name: data.full_name,
	owner: data.owner.login,
	description: data.description ?? null,
	language: data.language ?? null,
	is_fork: data.fork,
	forks: data.forks_count,
	stars: data.stargazers_count ?? data.stars_count ?? 0,
	created_at: dateToUnix(data.created_at),
	updated_at: dateToUnix(data.updated_at),
	pushed_at: dateToUnix(data.pushed_at ?? data.updated_at),
	license: data.license?.spdx_id ?? null,
	homepage: data.homepage ?? null,
	default_branch: data.default_branch,
	is_archived: data.archived,
});

/**
 * @param {'github' | 'codeberg'} platform
 */
export const getSchemaRepo = (platform) =>
	SchemaRepoBase.transform((data) => transformRepo(data, platform));

export const SchemaZon = z.object({
	name: z.string(),
	version: z.string(),
	minimum_zig_version: z.string().optional(),
	paths: z.array(z.string()).optional(),
	dependencies: z
		.record(
			z.union([
				z.object({
					url: z.string(),
					hash: z.string(),
					lazy: z.boolean().optional(),
				}),
				z.object({
					path: z.string(),
					lazy: z.boolean().optional(),
				}),
			]),
		)
		.optional(),
});

const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
const CODEBERG_API_KEY = process.env.CODEBERG_API_KEY;
if (!CODEBERG_API_KEY) fatal("CODEBERG_API_KEY is not set");

/**
 * @param {'github' | 'codeberg'} platform
 * @returns {HeadersInit}
 */
export const getHeaders = (platform) => {
	if (platform === "github") {
		return {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${GITHUB_API_KEY}`,
		};
	} else if (platform === "codeberg") {
		return {
			Authorization: `token ${CODEBERG_API_KEY}`,
		};
	}
	fatal(`getHeaders - invalid platform ${platform}`);
	return {}; // unreachable
};

/**
 * @param {string} filename
 * @returns {(repo: Repo) => string}
 */
const getMetadataURL = (filename) => (repo) => {
	if (repo.platform === "github") {
		return `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${filename}`;
	} else if (repo.platform === "codeberg") {
		return `https://codeberg.org/${repo.full_name}/raw/branch/${repo.default_branch}/${filename}`;
	}
	fatal(`getMetadataURL - invalid platform ${repo.platform}`);
	return ""; // unreachable
};

export const getZigBuildURL = getMetadataURL("build.zig");
export const getZigZonURL = getMetadataURL("build.zig.zon");

/**
 * @param {string} url
 * @returns {Promise<{
 *  status: number,
 *  fetched_at: number,
 *  content: string,
 *  }>}
 */
export const fetchMetadata = async (url) => {
	const response = await fetch(url);
	return {
		status: response.status,
		fetched_at: Math.floor(Date.now() / 1000),
		content: await response.text(),
	};
};

export const processDependencies = (full_name, parsed) => {
	const urlDeps = [];
	const deps = [];

	Object.entries(parsed.dependencies).forEach(([name, dep]) => {
		if ("url" in dep && "hash" in dep) {
			deps.push({
				full_name,
				name: name,
				dependency_type: "url",
				path: null,
				url_dependency_hash: dep.hash,
			});
			urlDeps.push({
				name: name,
				url: dep.url,
				hash: dep.hash,
			});
		} else if ("path" in dep) {
			deps.push({
				full_name,
				name: name,
				dependency_type: "path",
				path: dep.path,
				url_dependency_hash: null,
			});
		}
	});

	return { urlDeps, deps };
};

export const insertUrlDependencies = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT OR IGNORE INTO url_dependencies (hash, name, url)
		VALUES (?, ?, ?)
	`);

	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});
		const rows = parsed.map((item) => [item.hash, item.name, item.url]);
		upsertMany(rows);
		logger.info(`url_dependencies bulk insert - len ${rows.length}`);
	} catch (e) {
		logger.error(`url_dependencies bulk insert - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};

export const insertDependencies = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT OR REPLACE INTO zig_repo_dependencies (
			full_name, name, dependency_type, path, url_dependency_hash
		) VALUES (?, ?, ?, ?, ?)`);

	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});

		const rows = parsed.map((item) => [
			item.full_name,
			item.name,
			item.dependency_type,
			item.path,
			item.url_dependency_hash,
		]);

		upsertMany(rows);
		logger.info(`zig_repo_dependencies bulk insert - len ${rows.length}`);
	} catch (e) {
		logger.error(`zig_repo_dependencies bulk insert - ${e}`);
	}
};
