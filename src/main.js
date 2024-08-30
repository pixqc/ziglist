import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

// ----------------------------------------------------------------------------
// utils

/** @typedef {{id: number, full_name: string, default_branch: string, platform: 'github' | 'codeberg'}} RepoName */
/** @typedef {('trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal')} LogLevel */

/**
 * @returns {{
 *   trace: (message: string, data?: any) => void,
 *   debug: (message: string, data?: any) => void,
 *   info: (message: string, data?: any) => void,
 *   warn: (message: string, data?: any) => void,
 *   error: (message: string, data?: any) => void,
 *   fatal: (message: string, data?: any) => void,
 * }} A logger object with methods for each log level and a flush method.
 */
const createLogger = () => {
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
		if (level === "error") console.error(JSON.stringify(logEntry));
		else console.log(JSON.stringify(logEntry));
	};

	return {
		trace: (message, data) => log("trace", message, data),
		debug: (message, data) => log("debug", message, data),
		info: (message, data) => log("info", message, data),
		warn: (message, data) => log("warn", message, data),
		error: (message, data) => log("error", message, data),
		fatal: (message, data) => log("fatal", message, data),
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
const zon2json = (zon) => {
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
 * @param {RepoName} repo
 * @returns {Promise<RepoBuildZig>}
 */
const fetchZigContent = async (repo) => {
	logger.info(`fetch - fetchBuildZig - ${repo.full_name}`);
	const zigURL = getZigURL(repo);
	const zonURL = getZonURL(repo);
	const [zigResponse, zonResponse] = await Promise.all([
		fetch(zigURL),
		fetch(zonURL),
	]);
	return {
		repo_id: repo.id,
		fetched_at: Math.floor(Date.now() / 1000),
		build_zig_content:
			zigResponse.status === 200 ? await zigResponse.text() : null,
		build_zig_zon_content:
			zonResponse.status === 200 ? await zonResponse.text() : null,
	};
};

/**
 * @param {Response} response
 * @returns {string | undefined}
 */
const getNextURL = (response) => {
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

// snake case and null to keep consistency with db

/**
 * @typedef {Object} Repo
 * @property {number} id
 * @property {string} full_name
 * @property {string} platform
 * @property {string} name
 * @property {string} default_branch
 * @property {string} owner
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number} pushed_at
 * @property {string | null} description
 * @property {string | null} homepage
 * @property {string | null} license
 * @property {string | null} language
 * @property {number} stars
 * @property {number} forks
 * @property {boolean} is_fork
 * @property {boolean} is_archived
 */

/**
 * @typedef {Object} RepoBuildZig
 * @property {number} repo_id
 * @property {string | null} build_zig_content
 * @property {string | null} build_zig_zon_content
 * @property {number} fetched_at
 */

/**
 * @typedef {Object} RepoZon
 * @property {number} repo_id
 * @property {string} name
 * @property {string} version
 * @property {string | null} minimum_zig_version
 * @property {string[]} paths
 */

/**
 * @typedef {Object} RepoDependency
 * @property {string} name
 * @property {string} dependency_type
 * @property {string | null} path
 * @property {string | null} url_dependency_hash
 */

/**
 * @typedef {Object} UrlDependency
 * @property {string} hash
 * @property {string} name
 * @property {string} url
 */

/**
 * @param {Database} conn
 * @returns {void}
 */
export const initDB = (conn) => {
	conn.exec(`PRAGMA journal_mode = WAL;`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS repos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		full_name TEXT NOT NULL,
		platform TEXT NOT NULL,
		name TEXT,
		default_branch TEXT,
		owner TEXT,
		created_at INTEGER,
		updated_at INTEGER,
		pushed_at INTEGER,
		description TEXT NULL,
		homepage TEXT NULL,
		license TEXT NULL,
		language TEXT NULL,
		stars INTEGER,
		forks INTEGER,
		is_fork BOOLEAN,
		is_archived BOOLEAN,
		UNIQUE (platform, full_name)
	);`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS repo_zon (
		repo_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		version TEXT NOT NULL,
		minimum_zig_version TEXT NULL,
		paths TEXT NOT NULL,
		FOREIGN KEY (repo_id) REFERENCES repos(id) 
			ON DELETE CASCADE, 
		UNIQUE(repo_id, name, version)
	);`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS repo_build_zig (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id INTEGER NOT NULL,
		build_zig_content TEXT NULL,
		build_zig_zon_content TEXT NULL,
		fetched_at INTEGER NULL,
		FOREIGN KEY (repo_id) REFERENCES repos(id) 
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
	CREATE TABLE IF NOT EXISTS repo_dependencies (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		dependency_type TEXT CHECK(dependency_type IN ('url', 'path')) NOT NULL,
		path TEXT,
		url_dependency_hash TEXT,
		FOREIGN KEY (repo_id) REFERENCES repos(id) 
			ON DELETE CASCADE,
		FOREIGN KEY (url_dependency_hash) REFERENCES url_dependencies (hash),
		UNIQUE(repo_id, name, dependency_type, path),
		UNIQUE(repo_id, name, dependency_type, url_dependency_hash)
	);`);
	conn.exec(
		`CREATE INDEX IF NOT EXISTS idx_repos_created_at ON repos (created_at DESC);`,
	);
	conn.exec(`CREATE INDEX IF NOT EXISTS idx_repos_forks ON repos (forks);`);
	conn.exec(
		`CREATE INDEX IF NOT EXISTS idx_repo_zon_repo_id ON repo_zon (repo_id);`,
	);
	conn.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_build_zig_repo_id ON repo_build_zig (repo_id);`,
	);
	conn.exec(
		`CREATE INDEX IF NOT EXISTS idx_repo_dependencies_repo_id ON repo_dependencies (repo_id);`,
	);
	conn.exec(`
		CREATE INDEX IF NOT EXISTS idx_repos_fullname_nozigbee ON repos(full_name)
		WHERE full_name NOT LIKE '%zigbee%' COLLATE NOCASE;
	`);
	conn.exec(`
		CREATE INDEX IF NOT EXISTS idx_repos_description_zigbee ON repos(description)
		WHERE description NOT LIKE '%zigbee%' COLLATE NOCASE;
	`);
};

// putting these here so i can test them

export const serverHomeQuery = `
SELECT 
	r.*,
	rz.minimum_zig_version,
	CASE WHEN rbz.build_zig_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_exists,
	CASE WHEN rbz.build_zig_zon_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_zon_exists,
	GROUP_CONCAT(rd.name) AS dependencies
FROM repos r
LEFT JOIN repo_zon rz ON r.id = rz.repo_id
LEFT JOIN repo_build_zig rbz ON r.id = rbz.repo_id
LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
WHERE r.stars >= 10 AND r.forks >= 10
	AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
	AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
GROUP BY r.id
ORDER BY r.pushed_at DESC
LIMIT ? OFFSET ?;
`;

export const serverNewQuery = `
SELECT 
	r.*,
	rz.minimum_zig_version,
	CASE WHEN rbz.build_zig_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_exists,
	CASE WHEN rbz.build_zig_zon_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_zon_exists,
	GROUP_CONCAT(rd.name) AS dependencies
FROM repos r
LEFT JOIN repo_zon rz ON r.id = rz.repo_id
LEFT JOIN repo_build_zig rbz ON r.id = rbz.repo_id
LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
WHERE r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
	AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
GROUP BY r.id
ORDER BY r.created_at DESC
LIMIT ? OFFSET ?;
`;

export const serverTopQuery = `
SELECT 
	r.*,
	rz.minimum_zig_version,
	CASE WHEN rbz.build_zig_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_exists,
	CASE WHEN rbz.build_zig_zon_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_zon_exists,
	GROUP_CONCAT(rd.name) AS dependencies
FROM repos r
LEFT JOIN repo_zon rz ON r.id = rz.repo_id
LEFT JOIN repo_build_zig rbz ON r.id = rbz.repo_id
LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
WHERE r.forks >= 10
	AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
	AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
GROUP BY r.id
ORDER BY r.stars DESC
LIMIT ? OFFSET ?;
`;

export const serverSearchQuery = `
SELECT 
	r.*,
	rz.minimum_zig_version,
	CASE WHEN rbz.build_zig_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_exists,
	CASE WHEN rbz.build_zig_zon_content IS NOT NULL THEN 1 ELSE 0 END AS build_zig_zon_exists,
	GROUP_CONCAT(rd.name) AS dependencies
FROM repos_fts fts
JOIN repos r ON fts.full_name = r.full_name
LEFT JOIN repo_zon rz ON r.id = rz.repo_id
LEFT JOIN repo_build_zig rbz ON r.id = rbz.repo_id
LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
WHERE repos_fts MATCH ?
	AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
	AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
GROUP BY r.id
ORDER BY r.stars DESC
LIMIT ? OFFSET ?;
`;

export const serverDependencyQuery = `
SELECT
	r.full_name AS full_name,
	r.platform,
	json_group_array(
		json_object(
			'name', rd.name,
			'path', rd.path,
			'dependency_type', rd.dependency_type,
			'url_dependency_hash', rd.url_dependency_hash,
			'url', ud.url 
		)
	) AS dependencies
FROM repos AS r
INNER JOIN repo_dependencies AS rd
	ON r.id = rd.repo_id
LEFT JOIN url_dependencies AS ud
	ON rd.url_dependency_hash = ud.hash
GROUP BY r.full_name, r.platform
HAVING COUNT(rd.id) > 0;
`;

// ----------------------------------------------------------------------------
// extractors

/**
 * @param {any} data
 * @returns {Repo}
 */
const extractGithub = (data) => ({
	id: data.id,
	full_name: data.full_name,
	platform: "github",
	name: data.name,
	default_branch: data.default_branch,
	owner: data.owner.login,
	created_at: dateToUnix(data.created_at),
	updated_at: dateToUnix(data.updated_at),
	pushed_at: dateToUnix(data.pushed_at),
	description: data.description ?? null,
	homepage: data.homepage ?? null,
	license: data.license?.spdx_id ?? null,
	language: data.language ?? null,
	stars: data.stargazers_count,
	forks: data.forks_count,
	is_fork: data.fork,
	is_archived: data.archived,
});

/**
 * @param {any} data
 * @returns {Repo}
 */
const extractCodeberg = (data) => ({
	id: data.id,
	full_name: data.full_name,
	platform: "codeberg",
	name: data.name,
	default_branch: data.default_branch,
	owner: data.owner.login,
	created_at: dateToUnix(data.created_at),
	updated_at: dateToUnix(data.updated_at),
	pushed_at: dateToUnix(data.updated_at),
	description: data.description ?? null,
	homepage: data.homepage ?? null,
	license: data.license?.spdx_id ?? null,
	language: data.language ?? null,
	stars: data.stars_count,
	forks: data.forks_count,
	is_fork: data.fork,
	is_archived: data.archived,
});

const repoExtractors = {
	github: extractGithub,
	codeberg: extractCodeberg,
};

/**
 * @param {Object.<string, any>} dependencies
 * @returns {{urlDeps: UrlDependency[], deps: RepoDependency[]}}
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

// ----------------------------------------------------------------------------
// url stuffs

/**
 * @param {string} filename
 * @returns {(repo: RepoName) => string}
 */
const getBuildZigURL = (filename) => (repo) => {
	if (repo.platform === "github") {
		return `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${filename}`;
	} else if (repo.platform === "codeberg") {
		return `https://codeberg.org/${repo.full_name}/raw/branch/${repo.default_branch}/${filename}`;
	}
	fatal(`getBuildZigURL - invalid platform ${repo.platform}`);
	return ""; // unreachable
};

const getZigURL = getBuildZigURL("build.zig");
const getZonURL = getBuildZigURL("build.zig.zon");

/**
 * @param {'github' | 'codeberg'} platform
 * @returns {string}
 */
const getTopRepoURL = (platform) => {
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
 * to make sure the query returns <1k items per url
 */
const createDateGenerator = () => {
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

const dateGenerator = createDateGenerator();

/**
 * @param {'github' | 'codeberg'} platform
 * @returns {string}
 */
const getAllRepoURL = (platform) => {
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

const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
const CODEBERG_API_KEY = process.env.CODEBERG_API_KEY;
if (!CODEBERG_API_KEY) fatal("CODEBERG_API_KEY is not set");

export const headers = {
	github: {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		Authorization: `Bearer ${GITHUB_API_KEY}`,
	},
	codeberg: {
		Authorization: `token ${CODEBERG_API_KEY}`,
	},
};

// ----------------------------------------------------------------------------
// workers

/**
 * @param {Database} conn
 * @param {'github' | 'codeberg'} platform
 * @param {'top' | 'all'} type
 */
export const fetchRepo = async (conn, platform, type) => {
	logger.info(`fetch - worker-fetch-repo - ${platform} ${type}`);

	/** @type {string | undefined} */
	let url = type === "top" ? getTopRepoURL(platform) : getAllRepoURL(platform);
	while (url) {
		const response = await fetch(url, { headers: headers[platform] });
		if (response.status !== 200) {
			logger.error(
				`fetch - worker-fetch-repo - ${platform} ${type} - HTTP ${response.status}`,
			);
			break;
		}
		const data = await response.json();
		let items = platform === "codeberg" ? data.data : data.items;
		items = Array.isArray(items) ? items.filter(Boolean) : [];
		const parsed = items.map(repoExtractors[platform]);
		const stmt = conn.prepare(`
			INSERT INTO repos (
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
		logger.info(
			`fetch - worker-fetch-repo - ${platform} ${type} - ${items.length} repos - url: ${url}`,
		);
		url = getNextURL(response);
	}
	logger.info(`fetch - worker-fetch-repo - ${platform} ${type} - completed`);
};

/**
 * @param {Database} conn
 */
export const fetchBuildZig = async (conn) => {
	// rate limit: 5000 requests per hour, 83/min
	// 41 because fetching both build.zig and build.zig.zon, 41 * 2 = 82
	const repoIdStmt = conn.prepare(`
		SELECT r.id, r.full_name, r.default_branch, r.platform
		FROM repos r
		LEFT JOIN repo_build_zig rbz ON r.id = rbz.repo_id
		WHERE (
			rbz.fetched_at IS NULL
			OR (strftime('%s', 'now') - rbz.fetched_at) > 259200
		)
		AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
		AND (r.description IS NULL OR r.description NOT LIKE '%zigbee%' COLLATE NOCASE)
		ORDER BY r.stars DESC
		LIMIT 41;`);
	const repos = repoIdStmt.all();
	const parsed = await Promise.all(repos.map((repo) => fetchZigContent(repo)));
	const stmt = conn.prepare(`
		INSERT INTO repo_build_zig (
			repo_id, build_zig_content, build_zig_zon_content, fetched_at
		) VALUES (?, ?, ?, ?)
		ON CONFLICT(repo_id) DO UPDATE SET
			build_zig_content = excluded.build_zig_content,
			build_zig_zon_content = excluded.build_zig_zon_content,
			fetched_at = excluded.fetched_at
		`);
	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});

		const rows = parsed.map((item) => [
			item.repo_id,
			item.build_zig_content,
			item.build_zig_zon_content,
			item.fetched_at,
		]);

		upsertMany(rows);
		logger.info(`db - upsertBuildZig - len ${rows.length}`);
	} catch (e) {
		logger.error(`db - upsertBuildZig - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};

/**
 * fetching worker and processing worker should be separate
 *
 * @param {Database} conn
 */
export const processBuildZig = async (conn) => {
	const stmt = conn.prepare(`
		SELECT build_zig_zon_content, repo_id 
		FROM repo_build_zig
		WHERE build_zig_zon_content IS NOT NULL
	`);
	const rows = stmt.all();
	conn.exec("BEGIN TRANSACTION");
	try {
		for (const row of rows) {
			const data = JSON.parse(zon2json(row.build_zig_zon_content));
			const name = data.name;
			const version = data.version;
			const minimum_zig_version = data.minimum_zig_version ?? null;
			const paths = data.paths;
			let urlDeps = [];
			let deps = [];
			if (data.dependencies) {
				const transformedDependencies = transformDependencies(
					data.dependencies,
				);
				urlDeps = transformedDependencies.urlDeps;
				deps = transformedDependencies.deps;
			}

			const metadataStmt = conn.prepare(`
				INSERT OR REPLACE INTO repo_zon (repo_id, name, version, minimum_zig_version, paths)
				VALUES (?, ?, ?, ?, ?)
			`);
			const pathsString = paths !== undefined ? paths.join(",") : "";
			metadataStmt.run(
				row.repo_id,
				name,
				version,
				minimum_zig_version,
				pathsString,
			);

			const urlDepStmt = conn.prepare(`
				INSERT OR REPLACE INTO url_dependencies (hash, name, url)
				VALUES (?, ?, ?)
			`);
			for (const urlDep of urlDeps) {
				urlDepStmt.run(urlDep.hash, urlDep.name, urlDep.url);
			}

			const depStmt = conn.prepare(`
				INSERT OR REPLACE INTO repo_dependencies (repo_id, name, dependency_type, path, url_dependency_hash)
				VALUES (?, ?, ?, ?, ?)
			`);
			for (const dep of deps) {
				depStmt.run(
					row.repo_id,
					dep.name,
					dep.dependency_type,
					dep.dependency_type === "path" ? dep.path : null,
					dep.dependency_type === "url" ? dep.url_dependency_hash : null,
				);
			}
		}
		conn.exec("COMMIT");
		logger.info("db - worker-process-build-zig - completed successfully");
	} catch (error) {
		conn.exec("ROLLBACK");
		logger.error(`db - worker-process-build-zig - Error: ${error}`);
	}
};

/**
 * @param {Database} conn
 */
export const rebuildFts = async (conn) => {
	logger.info("db - worker-rebuild-fts - started");
	try {
		conn.exec("BEGIN TRANSACTION;");
		conn.exec(`DROP TABLE IF EXISTS repos_fts;`);
		conn.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS repos_fts USING fts5(
				owner, 
				name,
				full_name,
				description,
				content='repos',
				content_rowid='id'
			);`);
		conn.exec(`
			INSERT INTO repos_fts(rowid, owner, name, full_name, description)
				SELECT id, owner, name, full_name, description
				FROM repos;
		`);

		conn.exec("COMMIT;");
		logger.info("db - worker-rebuild-fts - completed successfully");
	} catch (e) {
		conn.exec("ROLLBACK;");
		logger.error(`db - worker-rebuild-fts - rollback -${e}`);
	}
};
