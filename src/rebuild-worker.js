import { zon2json, extractZon } from "./main.js";
import { Database } from "bun:sqlite";
import { logger } from "./main.js";

self.onmessage = async (event) => {
	const db = new Database(event.data.dbFilename);
	const stmt = db.prepare(`
		SELECT build_zig_zon_content, repo_id 
		FROM repo_build_zig
		WHERE build_zig_zon_content IS NOT NULL
	`);
	const rows = stmt.all();
	db.exec("BEGIN TRANSACTION");

	try {
		for (const row of rows) {
			const parsed = extractZon(
				JSON.parse(zon2json(row.build_zig_zon_content)),
			);

			const metadataStmt = db.prepare(`
				INSERT OR REPLACE INTO repo_zon (repo_id, name, version, minimum_zig_version, paths)
				VALUES (?, ?, ?, ?, ?)
			`);
			const pathsString = parsed.paths.join(",");
			metadataStmt.run(
				row.repo_id,
				parsed.name,
				parsed.version,
				parsed.minimum_zig_version,
				pathsString,
			);

			const urlDepStmt = db.prepare(`
				INSERT OR REPLACE INTO url_dependencies (hash, name, url)
				VALUES (?, ?, ?)
			`);
			for (const urlDep of parsed.urlDeps) {
				urlDepStmt.run(row.repo_id, urlDep.url, urlDep.hash);
			}

			const depStmt = db.prepare(`
				INSERT OR REPLACE INTO repo_dependencies (repo_id, name, dependency_type, path, url_dependency_hash)
				VALUES (?, ?, ?, ?, ?)
			`);
			for (const dep of parsed.deps) {
				depStmt.run(
					row.repo_id,
					dep.name,
					dep.dependency_type,
					dep.dependency_type === "path" ? dep.path : null,
					dep.dependency_type === "url" ? dep.url_dependency_hash : null,
				);
			}
		}
		db.exec("COMMIT");
		logger.info("db - processBuildZig - completed successfully");
	} catch (error) {
		db.exec("ROLLBACK");
		logger.error(`db - processBuildZig - Error: ${error}`);
	}
};

self.onerror = (e) => {
	logger.error(`rebuild-worker - ${e}`);
};
