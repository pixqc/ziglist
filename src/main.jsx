import { Database } from "bun:sqlite";
import { Hono } from "hono";

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
		fatal: (message, data) => {
			log("fatal", message, data);
			process.exit(1);
		},
	};
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

///**
// * @param {RepoName} repo
// * @returns {Promise<RepoBuildZig>}
// */
//const fetchZigContent = async (repo) => {
//	logger.info(`fetch - fetchBuildZig - ${repo.full_name}`);
//	const zigURL = getZigURL(repo);
//	const zonURL = getZonURL(repo);
//	const [zigResponse, zonResponse] = await Promise.all([
//		fetch(zigURL),
//		fetch(zonURL),
//	]);
//	return {
//		repo_id: repo.id,
//		fetched_at: Math.floor(Date.now() / 1000),
//		build_zig_content:
//			zigResponse.status === 200 ? await zigResponse.text() : null,
//		build_zig_zon_content:
//			zonResponse.status === 200 ? await zonResponse.text() : null,
//	};
//};

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
const initDB = (conn) => {
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

// putting server queries here so i can export and test them

const serverHomeQuery = `
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

const serverNewQuery = `
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

const serverTopQuery = `
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

const serverSearchQuery = `
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

const serverDependencyQuery = `
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
	logger.fatal(`getBuildZigURL - invalid platform ${repo.platform}`);
	return ""; // unreachable
};

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
	logger.fatal(`getRepoURL - invalid platform ${platform}`);
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
	logger.fatal(`getRepoURL - invalid platform ${platform}`);
	return ""; // unreachable
};

// ----------------------------------------------------------------------------
// workers (fetch+insert)

/** @param {'github' | 'codeberg'} platform
 * @param {'top' | 'all'} type
 * @returns {Promise<Repo[]>}
 */
const fetchRepos = async (platform, type) => {
	logger.info(`fetch - fetchRepos - ${platform} ${type}`);
	const url =
		type === "top" ? getTopRepoURL(platform) : getAllRepoURL(platform);
	const response = await fetch(url, { headers: headers[platform] });
	if (response.status !== 200) {
		logger.error(
			`fetch - fetchRepos - ${platform} ${type} - HTTP ${response.status}`,
		);
		return [];
	}
	const data = await response.json();
	let items = platform === "codeberg" ? data.data : data.items;
	items = Array.isArray(items) ? items.filter(Boolean) : [];
	const parsed = items.map(repoExtractors[platform]);
	logger.info(
		`fetch - fetchRepos - ${platform} ${type} - count ${parsed.length}`,
	);
	return parsed;
};

/**
 * @param {Database} conn
 * @param {Repo[]} parsed
 */
const upsertRepos = async (conn, parsed) => {
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
			for (const item of data) {
				stmt.run(
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
				);
			}
		});

		upsertMany(parsed);
		logger.info(`db - upsertRepos - count ${parsed.length}`);
	} catch (e) {
		logger.error(`db - upsertRepos - ${e}`);
	} finally {
		stmt.finalize();
	}
};

/**
 * @param {Database} conn
 * @returns {Promise<RepoName[]>}
 */
const getOutdatedZigBuilds = async (conn) => {
	// rate limit: 5000 requests per hour, 83/min
	// 41 because fetching both build.zig and build.zig.zon, 41 * 2 = 82
	const stmt = conn.prepare(`
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
	const repos = stmt.all();
	logger.info(`db - getOutdatedZigBuilds - count ${repos.length}`);
	return repos;
};

/**
 * @param {Database} conn
 * @returns {Promise<RepoBuildZig[]>}
 */
const fetchBuildZigs = async (conn) => {
	const repos = await getOutdatedZigBuilds(conn);
	return await Promise.all(
		repos.map(async (repo) => {
			logger.info(`fetch - fetchBuildZigs - ${repo.full_name}`);
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
		}),
	);
};

const upsertBuildZigs = async (conn, parsed) => {
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
			for (const item of data) {
				stmt.run(
					item.repo_id,
					item.build_zig_content,
					item.build_zig_zon_content,
					item.fetched_at,
				);
			}
		});

		upsertMany(parsed);
		logger.info(`db - upsertBuildZigs - count ${parsed.length}`);
	} catch (e) {
		logger.error(`db - upsertBuildZigs - ${e}`);
	} finally {
		stmt.finalize();
	}
};

const processBuildZigs = async (conn) => {
	const selectStmt = conn.prepare(`
		SELECT build_zig_zon_content, repo_id
		FROM repo_build_zig
		WHERE build_zig_zon_content IS NOT NULL
	`);

	const zonStmt = conn.prepare(`
		INSERT OR REPLACE INTO repo_zon (repo_id, name, version, minimum_zig_version, paths)
		VALUES (?, ?, ?, ?, ?)
	`);

	const urlDepStmt = conn.prepare(`
		INSERT INTO url_dependencies (hash, name, url)
		VALUES (?, ?, ?)
		ON CONFLICT DO NOTHING 
	`);

	const depStmt = conn.prepare(`
		INSERT INTO repo_dependencies (repo_id, name, dependency_type, path, url_dependency_hash)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT DO NOTHING 
	`);

	const upsertDependencies = conn.transaction((repoId, urlDeps, deps) => {
		for (const urlDep of urlDeps) {
			urlDepStmt.run(urlDep.hash, urlDep.name, urlDep.url);
		}
		for (const dep of deps) {
			depStmt.run(
				repoId,
				dep.name,
				dep.dependency_type,
				dep.dependency_type === "path" ? dep.path : null,
				dep.dependency_type === "url" ? dep.url_dependency_hash : null,
			);
		}
	});

	conn.exec("BEGIN TRANSACTION");
	try {
		for (const row of selectStmt.all()) {
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

			const pathsString = paths !== undefined ? paths.join(",") : "";
			zonStmt.run(row.repo_id, name, version, minimum_zig_version, pathsString);

			if (data.dependencies) {
				const transformedDependencies = transformDependencies(
					data.dependencies,
				);
				upsertDependencies(
					row.repo_id,
					transformedDependencies.urlDeps,
					transformedDependencies.deps,
				);
			}
		}
		conn.exec("COMMIT");
		logger.info("db - processBuildZigs - completed successfully");
	} catch (e) {
		conn.exec("ROLLBACK");
		logger.error(`db - processBuildZigs - ${e}`);
	} finally {
		selectStmt.finalize();
		zonStmt.finalize();
		urlDepStmt.finalize();
		depStmt.finalize();
	}
};

/**
 * @param {Database} conn
 */
const rebuildFts = async (conn) => {
	logger.info("db - rebuildFts - started");
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
		logger.info("db - rebuildFts - completed successfully");
	} catch (e) {
		conn.exec("ROLLBACK;");
		logger.error(`db - rebuildFts - ${e}`);
	}
};

// ----------------------------------------------------------------------------
// jsx

const LucideChevronLeft = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="lucide lucide-chevron-left"
	>
		<path d="m15 18-6-6 6-6" />
	</svg>
);

const LucideChevronRight = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="lucide lucide-chevron-right"
	>
		<path d="m9 18 6-6-6-6" />
	</svg>
);

const LucideGithub = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="lucide lucide-github"
	>
		<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
		<path d="M9 18c-4.51 2-5-2-7-2" />
	</svg>
);

const LucideSearch = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="lucide lucide-search"
	>
		<circle cx="11" cy="11" r="8" />
		<path d="m21 21-4.3-4.3" />
	</svg>
);

const LucideCircleOff = () => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="24"
		height="24"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="lucide lucide-circle-off"
	>
		<path d="m2 2 20 20" />
		<path d="M8.35 2.69A10 10 0 0 1 21.3 15.65" />
		<path d="M19.08 19.08A10 10 0 1 1 4.92 4.92" />
	</svg>
);

const SearchBar = ({ query }) => (
	<form action="/search" method="get">
		<div className="relative">
			<input
				className="w-full bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-md py-1 px-3 shadow-sm focus:outline-none focus:border-stone-400 dark:focus:border-stone-500 focus:ring-stone-400 dark:focus:ring-stone-500 focus:ring-1 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 text-sm"
				placeholder="search..."
				type="text"
				name="q"
				value={query}
			/>
			<button
				type="submit"
				className="absolute inset-y-0 right-0 flex items-center px-4 text-stone-700 dark:text-stone-300 bg-stone-100 dark:bg-stone-700 border-l border-stone-200 dark:border-stone-600 rounded-r-md hover:bg-stone-200 dark:hover:bg-stone-600 transition-colors"
			>
				<LucideSearch />
			</button>
		</div>
	</form>
);

const RepoDetail = ({ kind, value }) => (
	<div className="flex">
		<span className="text-sm text-stone-500 dark:text-stone-400">{kind}</span>
		<div className="grow flex flex-col px-3">
			<div className="h-1/2 border-b border-stone-200 dark:border-stone-700" />
			<div className="h-1/2 border-t border-stone-200 dark:border-stone-700" />
		</div>
		<span className="text-sm text-stone-500 dark:text-stone-400">{value}</span>
	</div>
);

const Badge = ({ value }) => (
	<span className="p-0.5 bg-[#eeedec] text-stone-500 dark:bg-[#363230] dark:text-stone-400 rounded-sm text-xs inline-block">
		{value}
	</span>
);

const SpecialCard = () => {
	return (
		<div className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block">
			<h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">
				More features coming soon!
			</h3>
			<p className="text-sm text-stone-700 dark:text-stone-300 mb-2">
				GitLab support, zigmod+gyro support, dependency graph, etc. Feature
				requests? Missing dependencies in one of the pkgs/projects? Let me know!
			</p>
			<div className="grow" />
			<a
				href="https://github.com/pixqc/ziglist/issues"
				target="_blank"
				rel="noopener noreferrer"
				className="inline-block w-full text-center text-sm py-1.5 bg-[#eeedec] dark:bg-[#363230] text-stone-800 dark:text-stone-200 rounded-md hover:bg-stone-300 dark:hover:bg-stone-600 transition-colors"
			>
				GitHub Issues
			</a>
		</div>
	);
};

const RepoCard = ({ repo }) => {
	const shownDeps = 5;
	const deps = repo.dependencies ? repo.dependencies.split(",") : [];
	const repoUrl =
		repo.platform === "github"
			? `https://github.com/${repo.full_name}`
			: `https://codeberg.org/${repo.full_name}`;

	return (
		<a
			href={repoUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors"
		>
			<h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1 hover:underline break-words">
				{repo.full_name}
			</h3>
			{repo.description && (
				<p className="text-sm text-stone-700 dark:text-stone-300 mb-2 break-words">
					{repo.description.length > 120
						? repo.description.slice(0, 120) + "..."
						: repo.description}
				</p>
			)}
			<div className="grow" />
			<div className="flex flex-wrap gap-1 mb-1">
				{repo.build_zig_exists === 1 && <Badge value={"build.zig ✓"} />}
				{repo.build_zig_zon_exists === 1 && <Badge value={"zon ✓"} />}
				{repo.is_fork === 1 && <Badge value={"fork:true"} />}
				{repo.build_zig_exists === 1 &&
					repo.language !== "Zig" &&
					repo.language !== null && <Badge value={`lang:${repo.language}`} />}
				{repo.platform === "codeberg" && <Badge value={"codeberg"} />}
			</div>
			{deps.length > 0 && (
				<div className="flex flex-wrap gap-1 items-center">
					<span className="text-sm text-stone-500 dark:text-stone-400">
						Deps:
					</span>
					{deps.slice(0, shownDeps).map((dep) => (
						<Badge value={dep} />
					))}
					{deps.length > shownDeps && (
						<span className="flex text-sm text-stone-500 dark:text-stone-400 grow">
							<div className="grow flex flex-col pr-3">
								<div className="h-1/2 border-b border-stone-200 dark:border-stone-700" />
								<div className="h-1/2 border-t border-stone-200 dark:border-stone-700" />
							</div>
							+{deps.length - shownDeps} more deps
						</span>
					)}
				</div>
			)}
			{repo.min_zig_version && (
				<RepoDetail kind="Min Zig" value={repo.min_zig_version.split("+")[0]} />
			)}
			<RepoDetail kind="Stars" value={formatNumberK(repo.stars)} />
			<RepoDetail kind="Last commit" value={timeAgo(repo.pushed_at)} />
		</a>
	);
};

const RepoGrid = ({ repos, page, currentPath }) => {
	const repoElements = repos.map((repo) => <RepoCard repo={repo} />);
	if (currentPath === "/" && page === 1) {
		repoElements.splice(2, 0, <SpecialCard key="special" />);
	}
	return (
		<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
			{repoElements}
		</div>
	);
};

const DependencyList = ({ repos }) => {
	return (
		<div>
			<div className="flex flex-wrap gap-1 items-center mb-6">
				<span className="text-sm text-stone-500 dark:text-stone-400">
					Popular dependencies:
				</span>
			</div>
			<p className="text-center mb-6 text-stone-300 dark:text-stone-600">
				· · ·
			</p>
			{repos.map((repo, index) => (
				<div key={index} className="mb-6 flex flex-col space-y-0">
					<h3 className="font-semibold text-stone-900 dark:text-stone-100 overflow-hidden">
						<a
							href={`https://github.com/${repo.full_name}`}
							target="_blank"
							rel="noopener noreferrer"
							className="hover:underline"
						>
							{repo.full_name}
						</a>
					</h3>
					<span className="font-normal text-sm text-stone-300 dark:text-stone-600">
						dependencies
					</span>
					<ul className="list-none p-0 m-0 overflow-hidden">
						{repo.dependencies.map((dep, depIndex) => (
							<li
								key={depIndex}
								className="text-sm text-stone-700 dark:text-stone-300 sm:flex sm:items-start"
							>
								<span className="flex-shrink-0 mr-1 sm:mr-0">{dep.name}</span>
								<div className="hidden sm:flex grow flex-col px-1 sm:px-2 pt-2.5 min-w-0">
									<div className="h-1/2 border-b border-stone-100 dark:border-stone-800" />
									<div className="h-1/2 border-t border-stone-100 dark:border-stone-800" />
								</div>
								{dep.dependency_type === "url" && (
									<span className="text-sm text-stone-400 dark:text-stone-500 break-all sm:text-right">
										{dep.url}
									</span>
								)}
								{dep.dependency_type === "path" && (
									<span className="jext-sm text-stone-400 dark:text-stone-500 sm:text-right">
										[path] {dep.path}
									</span>
								)}
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
};

const BaseLayout = ({ children }) => (
	<html lang="en" className="dark">
		<head>
			<meta charSet="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>ziglist.org</title>
			<style dangerouslySetInnerHTML={{ __html: tailwindcss }} />
		</head>
		<body className="bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100">
			{children}
		</body>
	</html>
);

const Pagination = ({ currentPath, page, query }) => {
	const prevPage = Math.max(1, page - 1);
	const nextPage = page + 1;
	const linkStyles =
		"px-2 py-2 flex items-center text-stone-400 dark:text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition-colors";
	const getPageUrl = (pageNum) => {
		let url = `${currentPath}?page=${pageNum}`;
		if (query) {
			url += `&q=${encodeURIComponent(query)}`;
		}
		return url;
	};
	return (
		<nav className="flex justify-center mb-6">
			<div className="flex items-center space-x-4">
				<a
					href={getPageUrl(prevPage)}
					className={`${linkStyles} ${
						page === 1 ? "pointer-events-none opacity-50" : ""
					}`}
					aria-disabled={page === 1}
				>
					<LucideChevronLeft />
					Prev
				</a>
				<a href={getPageUrl(nextPage)} className={linkStyles}>
					Next
					<LucideChevronRight />
				</a>
			</div>
		</nav>
	);
};

const Footer = () => (
	<div className="flex max-w-5xl mx-auto px-3 mb-6 space-x-4 items-center">
		<div className="grow flex flex-col">
			<div className="h-1/2 border-b border-stone-100 dark:border-stone-800" />
			<div className="h-1/2 border-t border-stone-100 dark:border-stone-800" />
		</div>
		<p className="text-stone-400 dark:text-stone-500 text-sm">
			ziglist.org by @pixqc (
			<a
				target="_blank"
				rel="noopener noreferrer"
				href="https://github.com/pixqc"
				className="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
			>
				GitHub
			</a>
			{"; "}
			<a
				target="_blank"
				rel="noopener noreferrer"
				href="https://x.com/pixqc"
				className="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
			>
				x.com
			</a>
			)
		</p>
	</div>
);

const Navigation = ({ currentPath, query }) => {
	const textActive = "text-stone-900 dark:text-stone-100";
	const textDisabled = "text-stone-400 dark:text-stone-500";
	const linkStyle =
		"hover:text-stone-900 dark:hover:text-stone-100 transition-colors";

	return (
		<>
			<div className="sm:hidden w-full px-3 mb-3">
				<SearchBar query={query} />
			</div>
			<div className="max-w-5xl mx-auto px-3 flex space-x-4 items-center">
				<a
					href="/"
					className={`${linkStyle} ${
						currentPath === "/" ? textActive : textDisabled
					}`}
				>
					Active
				</a>
				<a
					href="/new"
					className={`${linkStyle} ${
						currentPath === "/new" ? textActive : textDisabled
					}`}
				>
					New
				</a>
				<a
					href="/top"
					className={`${linkStyle} ${
						currentPath === "/top" ? textActive : textDisabled
					}`}
				>
					Top
				</a>
				<a
					href="/dependencies"
					className={`${linkStyle} ${
						currentPath === "/dependencies" ? textActive : textDisabled
					}`}
				>
					Deps
				</a>

				<div className="grow flex flex-col">
					<div className="h-1/2 border-b border-stone-100 dark:border-stone-800" />
					<div className="h-1/2 border-t border-stone-100 dark:border-stone-800" />
				</div>

				<div className="hidden sm:block w-full max-w-xs">
					<SearchBar query={query} />
				</div>
			</div>
		</>
	);
};

const Hero = () => (
	<section className="flex flex-col px-3 py-8 space-y-2 text-pretty md:text-center md:mx-auto md:max-w-[28rem]">
		<h1 className="font-semibold tracking-tight text-3xl md:text-4xl text-stone-900 dark:text-stone-100">
			Discover Zig projects <span className="inline-block">and packages</span>
		</h1>
		<h2 className="text-stone-500 dark:text-stone-400">
			Ziglist is a directory of the Zig ecosystem. Find new tools and libraries
			to use or contribute to.
		</h2>
	</section>
);

const Header = () => (
	<header className="sticky top-0 z-10 bg-white/40 dark:bg-stone-900/40 backdrop-blur-xl">
		<div className="max-w-5xl mx-auto p-3 flex items-center justify-between">
			<a
				href="/"
				className="text-lg font-bold text-stone-900 dark:text-stone-100 tracking-tighter"
			>
				ziglist.org
			</a>

			<div>
				<a
					href="https://github.com/pixqc/ziglist"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center space-x-1 py-1 px-2 text-xs font-medium text-stone-500 dark:text-stone-400 border border-stone-300 dark:border-stone-600 rounded-md hover:bg-stone-100 dark:hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-stone-500 transition-colors"
				>
					<LucideGithub />
					<span>Star</span>
				</a>
			</div>
		</div>
	</header>
);

const NoItems = () => (
	<div className="max-w-5xl mx-auto px-3 py-56 flex flex-col items-center space-y-4">
		<LucideCircleOff />
		<p className="text-sm text-stone-400 dark:text-stone-500">
			No results found.
		</p>
	</div>
);

// ----------------------------------------------------------------------------
// globals

const SECONDLY = 1000;
const MINUTELY = 60 * SECONDLY;
const HOURLY = 60 * MINUTELY;
const DAILY = 24 * HOURLY;

const logger = createLogger();

const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
if (!GITHUB_API_KEY) logger.fatal("GITHUB_API_KEY is not set");
const CODEBERG_API_KEY = process.env.CODEBERG_API_KEY;
if (!CODEBERG_API_KEY) logger.fatal("CODEBERG_API_KEY is not set");

const headers = {
	github: {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		Authorization: `Bearer ${GITHUB_API_KEY}`,
	},
	codeberg: {
		Authorization: `token ${CODEBERG_API_KEY}`,
	},
};

const getZigURL = getBuildZigURL("build.zig");
const getZonURL = getBuildZigURL("build.zig.zon");

const repoExtractors = {
	github: extractGithub,
	codeberg: extractCodeberg,
};

const dateGenerator = createDateGenerator();
const tailwindcss = await Bun.file("./assets/tailwind.css").text();

const db = new Database("db.sqlite");
initDB(db);

// ----------------------------------------------------------------------------
// server

const app = new Hono();
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const ms = Date.now() - start;
	logger.info(
		`server.${c.req.method} ${c.req.url} - ${c.res.status} - ${ms}ms`,
	);
});

app.get("/", (c) => {
	const page = parseInt(c.req.query("page") || "1", 10);
	const perPage = page === 1 ? 29 : 30;
	const offset = (page - 1) * perPage;
	const stmt = db.prepare(serverHomeQuery);
	const repos = stmt.all(perPage, offset);
	logger.info(`server.GET /?page=${page} - ${repos.length} from db`);

	if (repos.length === 0) {
		return c.html(
			<BaseLayout>
				<Header />
				<Hero />
				<Navigation currentPath={"/"} query={undefined} />
				<NoItems />
				<Footer />
			</BaseLayout>,
		);
	}

	return c.html(
		<BaseLayout>
			<Header />
			<Hero />
			<Navigation currentPath={"/"} query={undefined} />
			<div className="max-w-5xl mx-auto px-3 py-6">
				<RepoGrid repos={Object.values(repos)} currentPath="/" page={page} />
			</div>
			{page > 0 && (
				<Pagination page={page} currentPath={"/"} query={undefined} />
			)}
			<Footer />
		</BaseLayout>,
	);
});

app.get("/new", (c) => {
	const page = parseInt(c.req.query("page") || "1", 10);
	const perPage = page === 1 ? 29 : 30;
	const offset = (page - 1) * perPage;
	const stmt = db.prepare(serverNewQuery);
	const repos = stmt.all(perPage, offset);
	logger.info(`server.GET /new?page=${page} - ${repos.length} from db`);

	if (repos.length === 0) {
		return c.html(
			<BaseLayout>
				<Header />
				<Hero />
				<Navigation currentPath={"/new"} query={undefined} />
				<NoItems />
				<Footer />
			</BaseLayout>,
		);
	}

	return c.html(
		<BaseLayout>
			<Header />
			<Hero />
			<Navigation currentPath={"/new"} query={undefined} />
			<div className="max-w-5xl mx-auto px-3 py-6">
				<RepoGrid repos={Object.values(repos)} currentPath="/new" page={page} />
			</div>
			{page > 0 && (
				<Pagination page={page} currentPath={"/new"} query={undefined} />
			)}
			<Footer />
		</BaseLayout>,
	);
});

app.get("/top", (c) => {
	const page = parseInt(c.req.query("page") || "1", 10);
	const perPage = page === 1 ? 29 : 30;
	const offset = (page - 1) * perPage;
	const stmt = db.prepare(serverTopQuery);
	const repos = stmt.all(perPage, offset);
	logger.info(`server.GET /top?page=${page} - ${repos.length} from db`);

	if (repos.length === 0) {
		return c.html(
			<BaseLayout>
				<Header />
				<Hero />
				<Navigation currentPath={"/top"} query={undefined} />
				<NoItems />
				<Footer />
			</BaseLayout>,
		);
	}

	return c.html(
		<BaseLayout>
			<Header />
			<Hero />
			<Navigation currentPath={"/top"} query={undefined} />
			<div className="max-w-5xl mx-auto px-3 py-6">
				<RepoGrid repos={Object.values(repos)} currentPath="/top" page={page} />
			</div>
			{page > 0 && (
				<Pagination page={page} currentPath={"/top"} query={undefined} />
			)}
			<Footer />
		</BaseLayout>,
	);
});

app.get("/search", (c) => {
	const page = parseInt(c.req.query("page") || "1", 10);
	const perPage = page === 1 ? 29 : 30;
	const offset = (page - 1) * perPage;
	const rawQuery = c.req.query("q") || "";
	const query = rawQuery.replace(/[-_]/g, " ");

	if (query.trim() === "") return c.redirect("/");
	const stmt = db.prepare(serverSearchQuery);
	const repos = stmt.all(query, perPage, offset);
	logger.info(
		`server.GET /search?page=${page} - query: ${rawQuery} - ${repos.length} from db`,
	);

	if (repos.length === 0) {
		return c.html(
			<BaseLayout>
				<Header />
				<Hero />
				<Navigation currentPath={"/search"} query={rawQuery} />
				<NoItems />
				<Footer />
			</BaseLayout>,
		);
	}

	return c.html(
		<BaseLayout>
			<Header />
			<Hero />
			<Navigation currentPath={"/search"} query={rawQuery} />
			<div className="max-w-5xl mx-auto px-3 py-6">
				<RepoGrid
					repos={Object.values(repos)}
					currentPath="/search"
					page={page}
				/>
			</div>
			{page > 0 && (
				<Pagination page={page} currentPath={"/search"} query={rawQuery} />
			)}
			<Footer />
		</BaseLayout>,
	);
});

app.get("/dependencies", (c) => {
	const stmt = db.prepare(serverDependencyQuery);
	let repos = stmt.all();
	repos = repos.map((repo) => ({
		...repo,
		dependencies: JSON.parse(repo.dependencies),
	}));

	logger.info(`server.GET /dependencies - ${repos.length} from db`);
	return c.html(
		<BaseLayout>
			<BaseLayout>
				<Header />
				<Hero />
				<Navigation currentPath={"/dependencies"} query={undefined} />
				<div className="max-w-5xl mx-auto px-3 py-6">
					<DependencyList repos={repos} />
				</div>
				<Footer />
			</BaseLayout>
			,
		</BaseLayout>,
	);
});

export default {
	port: 8080,
	fetch: app.fetch,
};

// ----------------------------------------------------------------------------
// crons

//const parsed = await fetchRepos("github", "top");
//upsertRepos(db, parsed);
//
//const parsed2 = await fetchBuildZigs(db);
//upsertBuildZigs(db, parsed2);

processBuildZigs(db);

//fetchRepo(db, "github", "top");

//fetchRepo(db, "codeberg", "top");
//rebuildFts(db);
//
//setInterval(() => {
//	fetchRepo(db, "github", "all");
//}, MINUTELY * 5);
//
//setInterval(() => {
//	fetchRepo(db, "codeberg", "top");
//}, HOURLY * 2);
//
//setInterval(() => {
//	fetchBuildZig(db);
//}, MINUTELY);
//
//setInterval(() => {
//	processBuildZig(db);
//}, MINUTELY);
//
//setInterval(() => {
//	rebuildFts(db);
//}, HOURLY * 3);
