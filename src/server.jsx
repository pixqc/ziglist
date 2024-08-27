import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
	logger,
	formatNumberK,
	timeAgo,
	initDB,
	HOURLY,
	MINUTELY,
} from "./main.js";
const repoWorker = new Worker("./src/repo-worker.js");
const zonWorker = new Worker("./src/zon-worker.js");

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
			{repo.dependencies && repo.dependencies.length > 0 && (
				<div className="flex flex-wrap gap-1 items-center">
					<span className="text-sm text-stone-500 dark:text-stone-400">
						Deps:
					</span>
					{repo.dependencies.slice(0, shownDeps).map((dep) => (
						<Badge value={dep} />
					))}
					{repo.dependencies.length > shownDeps && (
						<span className="flex text-sm text-stone-500 dark:text-stone-400 grow">
							<div className="grow flex flex-col pr-3">
								<div className="h-1/2 border-b border-stone-200 dark:border-stone-700" />
								<div className="h-1/2 border-t border-stone-200 dark:border-stone-700" />
							</div>
							+{repo.dependencies.length - shownDeps} more deps
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

const tailwindcss = await Bun.file("./assets/tailwind.css").text();
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

const db = new Database("a.sqlite");
initDB(db);
export default {
	port: 8080,
	fetch: app.fetch,
};

//repoWorker.postMessage({
//	type: "top",
//	platform: "github",
//	dbFilename: db.filename,
//});

zonWorker.postMessage({
	dbFilename: db.filename,
});
