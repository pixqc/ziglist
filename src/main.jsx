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
		// if (level === "error") console.error(JSON.stringify(logEntry));
		// else console.log(JSON.stringify(logEntry));
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

/**
 * @param {string} url - return of getBuildZigURL or getZigZonURL
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

/**
 * @param {number} unixSecond
 * @returns {string}
 */
const timeAgo = (unixSecond) => {
	const moment = new Date().getTime() / 1000;
	const diff = moment - unixSecond;
	const intervals = [
		{ label: "yr", seconds: 31536000 },
		{ label: "wk", seconds: 604800 },
		{ label: "d", seconds: 86400 },
		{ label: "hr", seconds: 3600 },
		{ label: "min", seconds: 60 },
		{ label: "sec", seconds: 1 },
	];
	for (let i = 0; i < intervals.length; i++) {
		const count = Math.floor(diff / intervals[i].seconds);
		if (count > 0) {
			return `${count}${intervals[i].label} ago`;
		}
	}
	return "just now";
};

/**
 * 81930 -> 81.9k
 * 1000 -> 1.0k
 * 999 -> 999
 *
 * @param {number} num - The number to format.
 * @returns {string} - Formatted number as a string.
 */
const formatNumberK = (num) => {
	if (num < 1000) return num.toString();
	const thousands = num / 1000;
	return (Math.floor(thousands * 10) / 10).toFixed(1) + "k";
};

/**
 * Some queries are done where it's between two dates, GitHub only returns
 * 1000 items for a query, this between two date condition makes it possible
 * to query more than 1000 repos
 *
 * @param {Date} start
 * @param {Date} end
 * @returns {string}
 */
const makeDateRange = (start, end) =>
	`${start.toISOString().slice(0, 19)}Z..${end.toISOString().slice(0, 19)}Z`;

/**
 * @param {Date} date
 * @param {number} months
 * @returns {Date}
 */
const addMonths = (date, months) => {
	const newDate = new Date(date);
	newDate.setMonth(newDate.getMonth() + months);
	return newDate;
};

/**
 * @param {Response} response
 * @returns {string | undefined}
 */
export const getNextURL = (response) => {
	let next;
	const linkHeader = response.headers.get("link");
	if (linkHeader) {
		const nextLink = linkHeader
			.split(",")
			.find((part) => part.includes('rel="next"'));
		next = nextLink?.match(/<(.*)>/)?.[1];
	}
	return next;
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
	);`);
	conn.exec(`
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
	);`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS url_dependencies (
		hash TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		url TEXT NOT NULL
	);`);
	conn.exec(`
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
	);`);
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
					row.min_zig_version,
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
		INSERT INTO zig_repos (
			platform, full_name, name, owner, description, homepage, license, 
			created_at, updated_at, pushed_at, stars, forks, 
			is_fork, is_archived, default_branch, language
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (platform, full_name) DO UPDATE SET
			name = excluded.name,
			owner = excluded.owner,
			description = excluded.description,
			homepage = excluded.homepage,
			license = excluded.license,
			created_at = excluded.created_at,
			updated_at = excluded.updated_at,
			pushed_at = excluded.pushed_at,
			stars = excluded.stars,
			forks = excluded.forks,
			is_fork = excluded.is_fork,
			is_archived = excluded.is_archived,
			default_branch = excluded.default_branch,
			language = excluded.language
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

/** @typedef {Object} UrlDependency
 * @property {string} hash
 * @property {string} name
 * @property {string} url
 */

/**
 * @param {Database} conn
 * @param {UrlDependency[]} parsed
 */
export const insertUrlDependencies = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT OR IGNORE INTO url_dependencies (hash, name, url)
		VALUES (?, ?, ?)`);
	try {
		const insertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});
		const rows = parsed.map((item) => [item.hash, item.name, item.url]);
		insertMany(rows);
		logger.info(`db - insertUrlDependencies - len ${rows.length}`);
	} catch (e) {
		logger.error(`db - insertUrlDependencies - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};

/** @typedef {Object} ZigRepoDependency
 * @property {string} full_name
 * @property {string} name
 * @property {string} dependency_type
 * @property {string|null} path
 * @property {string|null} url_dependency_hash
 */

/**
 * @param {Database} conn
 * @param {ZigRepoDependency[]} parsed
 * @param {number} repo_id
 */
export const upsertDependencies = (conn, parsed, repo_id) => {
	const stmt = conn.prepare(`
		INSERT INTO zig_repo_dependencies (
			repo_id, name, dependency_type, path, url_dependency_hash
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (repo_id, name, dependency_type, path) 
		DO UPDATE SET
			url_dependency_hash = excluded.url_dependency_hash
		ON CONFLICT (repo_id, name, dependency_type, url_dependency_hash) 
		DO UPDATE SET
			path = excluded.path`);
	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(
					repo_id,
					row.name,
					row.dependency_type,
					row.dependency_type === "path" ? row.path : null,
					row.dependency_type === "url" ? row.url_dependency_hash : null,
				);
			}
		});
		upsertMany(parsed);
		logger.info(`db - upsertDependencies - len ${parsed.length}`);
	} catch (e) {
		logger.error(`db - upsertDependencies - ${e}`);
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

const SchemaZonDependency = z.union([
	z.object({
		url: z.string(),
		hash: z.string(),
		lazy: z.boolean().optional(),
	}),
	z.object({
		path: z.string(),
		lazy: z.boolean().optional(),
	}),
]);
const SchemaZonDependencies = z.record(SchemaZonDependency);

/**
 * @param {z.infer<typeof SchemaZonDependencies>} dependencies
 */
const transformDependencies = (dependencies) => {
	const urlDeps = [];
	const deps = [];
	Object.entries(dependencies).forEach(([name, dep]) => {
		if ("url" in dep && "hash" in dep) {
			deps.push({
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
				name: name,
				dependency_type: "path",
				path: dep.path,
				url_dependency_hash: null,
			});
		}
	});
	return { urlDeps, deps };
};

export const SchemaZon = z
	.object({
		name: z.string(),
		version: z.string(),
		minimum_zig_version: z.string().optional(),
		paths: z.array(z.string()).optional(),
		dependencies: SchemaZonDependencies.optional(),
	})
	.transform((data) => {
		const { dependencies, ...rest } = data;
		const { urlDeps, deps } = dependencies
			? transformDependencies(dependencies)
			: { urlDeps: [], deps: [] };
		return {
			...rest,
			urlDeps,
			deps,
		};
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
 * @param {'github' | 'codeberg'} platform
 * @returns {string}
 */
export const getTopRepoURL = (platform) => {
	if (platform === "github") {
		const base = "https://api.github.com/search/repositories";
		const query = "language:zig";
		return `${base}?q=${encodeURIComponent(query)}&per_page=100&page=1`;
	} else if (platform === "codeberg") {
		const base = "https://codeberg.org/api/v1/repos/search";
		const query = "zig";
		return `${base}?q=${encodeURIComponent(query)}&includeDesc=true&page=1&limit=50`;
	}
	fatal(`getRepoURL - invalid platform ${platform}`);
	return ""; // unreachable
};

/**
 * the date range is used to fetch all repos from github, it's hardcoded
 * to make sure the query returns <1k items per
 */
const createDateGenerator = () => {
	// first index: zig init date,
	// commit 8e08cf4bec80b87a7a22a18086a3db5c2c0f1772
	const dates = [
		new Date("2015-07-04"),
		new Date("2017-09-02"),
		new Date("2019-02-09"),
		new Date("2020-01-11"),
		new Date("2020-08-22"),
		new Date("2021-02-27"),
		new Date("2021-07-31"),
		new Date("2021-12-18"),
		new Date("2022-04-16"),
		new Date("2022-07-30"),
		new Date("2022-11-19"),
		new Date("2023-02-25"),
		new Date("2023-05-20"),
		new Date("2023-07-29"),
		new Date("2023-09-30"),
		new Date("2023-12-02"),
		new Date("2024-01-20"),
		new Date("2024-03-16"),
		new Date("2024-05-04"),
	];

	let index = 0;
	let monthsAfterLast = 0;

	return function* () {
		while (true) {
			let start, end;
			if (index < dates.length - 1) {
				start = dates[index];
				end = dates[index + 1];
				index++;
			} else {
				start = addMonths(dates[dates.length - 1], monthsAfterLast);
				end = addMonths(dates[dates.length - 1], monthsAfterLast + 1);
				monthsAfterLast++;
				if (end > new Date()) {
					index = 0;
					monthsAfterLast = 0;
				}
			}
			yield { start, end };
		}
	};
};

export const dateGenerator = createDateGenerator();

/**
 * @param {'github' | 'codeberg'} platform
 * @returns {string}
 */
export const getAllRepoURL = (platform) => {
	if (platform === "github") {
		const base = "https://api.github.com/search/repositories";
		const { start, end } = dateGenerator().next().value;
		const dateRange = makeDateRange(start, end);
		const query = `in:name,description,topics zig created:${dateRange}`;
		return `${base}?q=${encodeURIComponent(query)}&per_page=100&page=1`;
	}
	// codeberg's top url contain all repos, it's unused here
	fatal(`getRepoURL - invalid platform ${platform}`);
	return ""; // unreachable
};
