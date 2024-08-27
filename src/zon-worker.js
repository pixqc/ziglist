import { Database } from "bun:sqlite";
import { fetchBuildZig, upsertBuildZig, logger } from "./main.js";

self.onmessage = async (event) => {
	const db = new Database(event.data.dbFilename);
	const repoIdStmt = db.prepare(`
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
		LIMIT 2;
`);
	const repos = repoIdStmt.all();
	const results = await Promise.all(repos.map((repo) => fetchBuildZig(repo)));
	upsertBuildZig(db, results);
};

self.onerror = (e) => {
	logger.error(`zon-worker - ${e}`);
};
