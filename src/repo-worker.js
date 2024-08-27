import { Database } from "bun:sqlite";
import {
	logger,
	headers,
	getTopRepoURL,
	repoExtractors,
	upsertZigRepos,
	getNextURL,
	getAllRepoURL,
} from "./main.js";

self.onmessage = async (event) => {
	logger.info(
		`fetch - repo-worker - ${event.data.type} - ${event.data.platform}`,
	);
	const type = event.data.type;
	const platform = event.data.platform;
	const dbFilename = event.data.dbFilename;
	const db = new Database(dbFilename);
	/** @type {string | undefined} */
	let url = type === "top" ? getTopRepoURL(platform) : getAllRepoURL(platform);
	while (url) {
		const response = await fetch(url, { headers: headers[platform] });
		if (response.status !== 200) {
			logger.error(
				`fetch - repo-worker - ${platform} ${type} - HTTP ${response.status}`,
			);
			break;
		}
		const data = await response.json();
		let items = platform === "codeberg" ? data.data : data.items;
		items = Array.isArray(items) ? items.filter(Boolean) : [];
		const parsed = items.map(repoExtractors[platform]);
		upsertZigRepos(db, parsed);
		logger.info(
			`fetch - fetchAndUpsertRepo - ${platform} ${type} - ${items.length} repos - url: ${url}`,
		);
		url = getNextURL(response);
	}
	logger.info(`fetch - fetchAndUpsertRepo - ${platform} ${type} - completed`);
};
