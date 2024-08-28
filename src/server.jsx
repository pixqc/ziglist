import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
	logger,
	initDB,
	BaseLayout,
	Header,
	Hero,
	Navigation,
	Footer,
	RepoGrid,
	Pagination,
	NoItems,
	fetchRepo,
} from "./main.jsx";

const app = new Hono();

const db = new Database("a.sqlite");
initDB(db);

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
	const stmt = db.prepare(`
		SELECT 
			r.*,
			rm.min_zig_version,
			rm.build_zig_exists,
			rm.build_zig_zon_exists,
			GROUP_CONCAT(rd.name) AS dependencies
		FROM repos r
		LEFT JOIN repo_metadata rm ON r.id = rm.repo_id
		LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
		WHERE r.stars >= 10 AND r.forks >= 10
			AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
			AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
		GROUP BY r.id
		ORDER BY r.pushed_at DESC
		LIMIT ? OFFSET ?
	`);

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
	const stmt = db.prepare(`
		SELECT 
			r.*,
			rm.min_zig_version,
			rm.build_zig_exists,
			rm.build_zig_zon_exists,
			GROUP_CONCAT(rd.name) AS dependencies
		FROM repos r
		LEFT JOIN repo_metadata rm ON r.id = rm.repo_id
		LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
		WHERE r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
			AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
		GROUP BY r.id
		ORDER BY r.created_at DESC
		LIMIT ? OFFSET ?
	`);

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
	const stmt = db.prepare(`
		SELECT 
			r.*,
			rm.min_zig_version,
			rm.build_zig_exists,
			rm.build_zig_zon_exists,
			GROUP_CONCAT(rd.name) AS dependencies
		FROM repos r
		LEFT JOIN repo_metadata rm ON r.id = rm.repo_id
		LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
		WHERE r.forks >= 10
			AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
			AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
		GROUP BY r.id
		ORDER BY r.stars DESC
		LIMIT ? OFFSET ?
	`);

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
	const stmt = db.prepare(`
		SELECT 
			r.*,
			rm.min_zig_version,
			rm.build_zig_exists,
			rm.build_zig_zon_exists,
			GROUP_CONCAT(rd.name) AS dependencies
		FROM repos_fts fts
		JOIN repos r ON fts.full_name = r.full_name
		LEFT JOIN repo_metadata rm ON r.id = rm.repo_id
		LEFT JOIN repo_dependencies rd ON r.id = rd.repo_id
		WHERE repos_fts MATCH ?
			AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
			AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
		GROUP BY r.id
		ORDER BY r.stars DESC
		LIMIT ? OFFSET ?
	`);

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

export default {
	port: 8080,
	fetch: app.fetch,
};

setInterval(() => {
	logger.flush();
}, 1000 * 10);

fetchRepo(db, "github", "top");

//
//workerFetchRepo.postMessage({
//	type: "top",
//	platform: "github",
//	dbFilename: db.filename,
//});
//
////workerFetchBuildZig.postMessage({
////	dbFilename: db.filename,
////});
//
////workerProcessBuildZig.postMessage({
////	dbFilename: db.filename,
////});
