import { z } from "zod";
import { appendFileSync } from "node:fs";

/**
 * @typedef {('trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal')} LogLevel
 *
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
const createLogger = () => {
	/** @type {string[]} */
	let buffer = [];

	/**
	 * Logs a message with a log level and optional data.
	 * @param {LogLevel} level - Log level.
	 * @param {string} message - Log message.
	 * @param {any} [data] - Additional data to log (optional).
	 * @returns {void}
	 */
	const log = (level, message, data) => {
		const now = new Date().toISOString();
		const msg = `${now} ${level.toUpperCase()}: ${message}`;
		if (data !== undefined) {
			buffer.push(`${msg} ${JSON.stringify(data)}`);
			console.log(msg, data);
		} else {
			buffer.push(msg);
			console.log(msg);
		}
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
const logger = createLogger();

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
 * @param {'github' | 'codeberg'} type
 */
export const getSchemaRepo = (type) => {
	/**
	 * @param {string} dateString
	 * @returns {number}
	 */
	const dateToUnix = (dateString) =>
		Math.floor(new Date(dateString).getTime() / 1000);

	const SchemaRepoBase = z.object({
		name: z.string(),
		full_name: z.string(),
		owner: z.object({ login: z.string() }),
		description: z.string().nullish(),
		language: z.string().nullish(),
		fork: z.boolean(),
		forks_count: z.number(),
		created_at: z.string().transform(dateToUnix),
		updated_at: z.string().transform(dateToUnix),
		license: z.object({ spdx_id: z.string() }).nullish(),
		homepage: z.string().nullish(),
		default_branch: z.string(),
	});

	if (type === "github") {
		return SchemaRepoBase.extend({
			pushed_at: z.string().transform(dateToUnix),
			stargazers_count: z.number().transform((val) => val),
		}).transform(
			({
				owner,
				license,
				stargazers_count,
				forks_count,
				homepage,
				fork,
				...rest
			}) => ({
				owner: owner.login,
				license: license?.spdx_id || null,
				stars: stargazers_count,
				forks: forks_count,
				homepage: homepage || null,
				is_fork: fork,
				...rest,
			}),
		);
	} else if (type === "codeberg") {
		return SchemaRepoBase.extend({
			stars_count: z.number(),
		}).transform(
			({
				full_name,
				owner,
				license,
				stars_count,
				forks_count,
				homepage,
				fork,
				updated_at,
				...rest
			}) => ({
				full_name: "codeberg:" + full_name,
				owner: owner.login,
				license: license?.spdx_id || null,
				stars: stars_count,
				forks: forks_count,
				homepage: homepage || null,
				pushed_at: updated_at,
				updated_at: updated_at,
				is_fork: fork,
				...rest,
			}),
		);
	}
	fatal(`getSchemaRepo - invalid type ${type}`);
	return {}; // unreachable
};

const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
const CODEBERG_API_KEY = process.env.CODEBERG_API_KEY;
if (!CODEBERG_API_KEY) fatal("CODEBERG_API_KEY is not set");

/**
 * @param {'github' | 'codeberg'} type
 * @returns {HeadersInit}
 */
export const getHeaders = (type) => {
	if (type === "github") {
		return {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${GITHUB_API_KEY}`,
		};
	} else if (type === "codeberg") {
		return {
			Authorization: `token ${CODEBERG_API_KEY}`,
		};
	}
	fatal(`getHeaders - invalid type ${type}`);
	return {}; // unreachable
};

/**
 * @param {'github' | 'codeberg'} type
 * @returns {string}
 */
export const getURL = (type) => {
	if (type === "github") {
		return "https://api.github.com/repos/ziglang/zig";
	} else if (type === "codeberg") {
		return "https://codeberg.org/api/v1/repos/ziglings/exercises";
	}
	fatal(`getURL - invalid type ${type}`);
	return ""; // unreachable
};

export const initDB = (conn) => {
	conn.exec(`PRAGMA journal_mode = WAL;`);
	conn.exec(`
	CREATE TABLE IF NOT EXISTS zig_repos (
		full_name TEXT PRIMARY KEY,
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
		default_branch TEXT,
		language TEXT
	);
`);
};

export const zigReposInsert = (conn, parsed) => {
	const stmt = conn.prepare(`
		INSERT INTO zig_repos (
			full_name, name, owner, description, homepage, license, 
			created_at, updated_at, pushed_at, stars, forks, 
			is_fork, default_branch, language
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	try {
		const upsertMany = conn.transaction((data) => {
			for (const row of data) {
				stmt.run(row);
			}
		});
		const rows = parsed.map((item) => [
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
			item.default_branch,
			item.language,
		]);
		upsertMany(rows);
		logger.info(`zig_repos bulk insert - len ${rows.length}`);
	} catch (e) {
		logger.error(`zig_repos bulk insert - ${e}`);
	} finally {
		if (stmt) stmt.finalize();
	}
};
