import "@std/dotenv/load";
import { Database } from "sqlite";
import { z } from "zod";
import { S3Client } from "s3";
import { Hono } from "hono";

// TODO:
// -

// ----------------------------------------------------------------------------
// utils

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
      await Deno.writeTextFile("log.txt", bufStr, { append: true });
      buffer = [];
    },
  };
};

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
  Deno.exit(1);
};

/**
 * @param {number} unixSecond
 * @returns {string} - Human-readable time difference.
 */
const timeAgo = (unixSecond) => {
  const moment = (new Date()).getTime() / 1000;
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
 * @param {Date} date
 * @param {number} weeks
 * @returns {Date}
 */
const addWeeks = (date, weeks) => {
  const millisecondsPerWeek = 7 * 24 * 60 * 60 * 1000;
  return new Date(date.getTime() + weeks * millisecondsPerWeek);
};

/**
 * @param {Date} date
 * @param {number} months
 * @returns {Date}
 */
const addMonths = (date, months) => {
  const millisecondsPerMonth = 30 * 24 * 60 * 60 * 1000;
  return new Date(date.getTime() + months * millisecondsPerMonth);
};

// ----------------------------------------------------------------------------
// jsx components
// note: this is not a React application, jsx is only for templating

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

const Badge = ({ value }) => (
  <span className="p-0.5 bg-[#eeedec] text-stone-500 dark:bg-[#363230] dark:text-stone-400 rounded-sm text-xs inline-block">
    {value}
  </span>
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

const SpecialCard = () => {
  return (
    <div className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block">
      <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">
        More features coming soon!
      </h3>
      <p className="text-sm text-stone-700 dark:text-stone-300 mb-2">
        Codeberg+GitLab support, zigmod+gyro support, dependency graph, etc.
        Feature requests? Missing dependencies in one of the pkgs/projects? Let
        me know!
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
  return (
    <a
      href={`https://github.com/${repo.owner}/${repo.name}`}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors"
    >
      <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1 hover:underline break-words">
        {repo.owner}/{repo.name}
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
        {repo.build_zig_exists === 1 && repo.language !== "Zig" &&
          repo.language !== null && <Badge value={`lang:${repo.language}`} />}
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
        <RepoDetail
          kind="Min Zig"
          value={repo.min_zig_version.split("+")[0]}
        />
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

const Navigation = ({ currentPath, query }) => {
  const textActive = "text-stone-900 dark:text-stone-100";
  const textDisabled = "text-stone-400 dark:text-stone-500";
  const linkStyle =
    "hover:text-stone-900 dark:hover:text-stone-100 transition-colors";

  return (
    <>
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
      <div className="sm:hidden w-full px-3 mt-1">
        <SearchBar query={query} />
      </div>
    </>
  );
};

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
        <a
          href={getPageUrl(nextPage)}
          className={linkStyles}
        >
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

const BaseLayout = ({ children }) => (
  <>
    {"<!DOCTYPE html>"}
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
  </>
);

const DependencyList = ({ deps }) => {
  return (
    <div>
      <div className="flex flex-wrap gap-1 items-center mb-6">
        <span className="text-sm text-stone-500 dark:text-stone-400">
          Popular dependencies:
        </span>
        {popularDependencies.map((dep) => <Badge value={dep} />)}
      </div>
      <p className="text-center mb-6 text-stone-300 dark:text-stone-600">
        · · ·
      </p>
      {deps.map((repo, index) => (
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
                {dep.type === "url" && (
                  <span className="text-sm text-stone-400 dark:text-stone-500 break-all sm:text-right">
                    {dep.url}
                  </span>
                )}
                {dep.type === "path" && (
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

const NoItems = () => (
  <div className="max-w-5xl mx-auto px-3 py-56 flex flex-col items-center space-y-4">
    <LucideCircleOff />
    <p className="text-sm text-stone-400 dark:text-stone-500">
      No results found.
    </p>
  </div>
);

// ----------------------------------------------------------------------------
// routes

const app = new Hono();

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info(`${c.req.method} ${c.req.url} - ${c.res.status} - ${ms}ms`);
});

app.get("/", (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = page === 1 ? 29 : 30;
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT
      r.*,
      GROUP_CONCAT(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE r.stars >= 10 AND r.forks >= 10
      AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.full_name NOT IN (${excludedRepos.map(() => "?").join(", ")})
    GROUP BY r.full_name
    ORDER BY r.pushed_at DESC
    LIMIT ? OFFSET ?
  `);

  const repos = stmt.all(...excludedRepos, perPage, offset);
  stmt.finalize();

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

  repos.forEach((repo) => {
    if (repo.dependencies == null) repo.dependencies = [];
    else repo.dependencies = repo.dependencies.split(",");
  });

  logger.info(`GET /?page=${page} - ${repos.length} from db`);
  return c.html(
    <BaseLayout>
      <Header />
      <Hero />
      <Navigation currentPath={"/"} query={undefined} />
      <div className="max-w-5xl mx-auto px-3 py-6">
        <RepoGrid repos={Object.values(repos)} currentPath="/" page={page} />
      </div>
      {typeof page === "number" && page > 0 && (
        <Pagination page={page} currentPath={"/"} query={undefined} />
      )}
      <Footer />
    </BaseLayout>,
  );
});

app.get("/new", (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT
      r.*,
      GROUP_CONCAT(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.full_name NOT IN (${excludedRepos.map(() => "?").join(", ")})
    GROUP BY r.full_name
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(...excludedRepos, perPage, offset);
  stmt.finalize();

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

  repos.forEach((repo) => {
    if (repo.dependencies == null) repo.dependencies = [];
    else repo.dependencies = repo.dependencies.split(",");
  });

  logger.info(`GET /new?page=${page} - ${repos.length} from db`);
  return c.html(
    <BaseLayout>
      <BaseLayout>
        <Header />
        <Hero />
        <Navigation currentPath={"/new"} query={undefined} />
        <div className="max-w-5xl mx-auto px-3 py-6">
          <RepoGrid
            repos={Object.values(repos)}
            currentPath="/new"
            page={page}
          />
        </div>
        {typeof page === "number" && page > 0 && (
          <Pagination page={page} currentPath={"/new"} query={undefined} />
        )}
        <Footer />
      </BaseLayout>,
    </BaseLayout>,
  );
});

app.get("/top", (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT
      r.*,
      GROUP_CONCAT(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE r.forks >= 10
      AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.full_name NOT IN (${excludedRepos.map(() => "?").join(", ")})
    GROUP BY r.full_name
    ORDER BY r.stars DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(...excludedRepos, perPage, offset);
  stmt.finalize();

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

  repos.forEach((repo) => {
    if (repo.dependencies == null) repo.dependencies = [];
    else repo.dependencies = repo.dependencies.split(",");
  });

  logger.info(`GET /top?page=${page} - ${repos.length} from db`);
  return c.html(
    <BaseLayout>
      <BaseLayout>
        <Header />
        <Hero />
        <Navigation currentPath={"/top"} query={undefined} />
        <div className="max-w-5xl mx-auto px-3 py-6">
          <RepoGrid
            repos={Object.values(repos)}
            currentPath="/top"
            page={page}
          />
        </div>
        {page > 0 && (
          <Pagination page={page} currentPath={"/top"} query={undefined} />
        )}
        <Footer />
      </BaseLayout>,
    </BaseLayout>,
  );
});

app.get("/search", (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const rawQuery = c.req.query("q") || "";
  const query = rawQuery.replace(/[-_]/g, " ");

  if (query.trim() === "") return c.redirect("/");

  const stmt = db.prepare(`
    SELECT 
      r.*,
      GROUP_CONCAT(d.name) AS dependencies
    FROM zig_repos r
    JOIN zig_repos_fts fts ON r.full_name = fts.full_name
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE zig_repos_fts MATCH ?
      AND r.full_name NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.description NOT LIKE '%zigbee%' COLLATE NOCASE
      AND r.full_name NOT IN (${excludedRepos.map(() => "?").join(", ")})
    GROUP BY r.full_name
    ORDER BY r.stars DESC
    LIMIT ? OFFSET ?
  `);

  const repos = stmt.all(query, ...excludedRepos, perPage, offset);
  stmt.finalize();
  repos.forEach((repo) => {
    if (repo.dependencies == null) repo.dependencies = [];
    else repo.dependencies = repo.dependencies.split(",");
  });

  // this is wrong btw, it's not escaping the query
  logger.info(
    `GET /search?q=${rawQuery}&page=${page} - ${repos.length} results from db`,
  );

  if (repos.length === 0) {
    return c.html(
      <BaseLayout>
        <Header />
        <Hero />
        <Navigation currentPath={"/"} query={rawQuery} />
        <NoItems />
        <Footer />
      </BaseLayout>,
    );
  }

  return c.html(
    <BaseLayout>
      <BaseLayout>
        <Header />
        <Hero />
        <Navigation currentPath={"/search"} query={rawQuery} />
        <div className="max-w-5xl mx-auto px-3 py-6">
          <RepoGrid
            repos={Object.values(repos)}
            currentPath="/top"
            page={page}
          />
        </div>
        {page > 0 && (
          <Pagination page={page} currentPath={"/search"} query={rawQuery} />
        )}
        <Footer />
      </BaseLayout>,
    </BaseLayout>,
  );
});

app.get("/dependencies", (c) => {
  const stmt = db.prepare(`
    SELECT
      zrd.full_name,
      JSON_GROUP_ARRAY(
        JSON_OBJECT(
          'name', zrd.name,
          'type', zrd.dependency_type,
          'path', CASE WHEN zrd.dependency_type = 'path' THEN zrd.path ELSE NULL END,
          'url', CASE WHEN zrd.dependency_type = 'url' THEN ud.url ELSE NULL END,
          'hash', CASE WHEN zrd.dependency_type = 'url' THEN zrd.url_dependency_hash ELSE NULL END
        )
      ) AS dependencies
    FROM
      zig_repo_dependencies zrd
    LEFT JOIN
      url_dependencies ud ON zrd.url_dependency_hash = ud.hash
    GROUP BY
      zrd.full_name
    `);

  const deps = stmt.all();
  stmt.finalize();

  logger.info(`GET /dependencies - ${deps.length} results from db`);
  return c.html(
    <BaseLayout>
      <BaseLayout>
        <Header />
        <Hero />
        <Navigation currentPath={"/dependencies"} query={undefined} />
        <div className="max-w-5xl mx-auto px-3 py-6">
          <DependencyList deps={deps} />
        </div>
        <Footer />
      </BaseLayout>,
    </BaseLayout>,
  );
});

const Page404 = () => (
  <div className="p-3 max-w-sm mx-auto">
    <p className="text-sm text-stone-500 dark:text-stone-400">
      Page not found. Back to{"  "}
      <a
        href="/"
        className="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        ziglist.org
      </a>
    </p>
  </div>
);

app.notFound((c) => {
  return c.html(
    <BaseLayout>
      <Page404 />
    </BaseLayout>,
    404,
  );
});

// ----------------------------------------------------------------------------
// indexer

/**
 * const url = "https://api.github.com/search/repositories?q=language%3Azig"
 * const response = await fetch(url)
 * const data = await response.json()
 * const parsed = data.items.map(SchemaRepo.parse)
 */
const SchemaRepo = z.object({
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  description: z.string().nullish(),
  language: z.string().nullish(),
  stargazers_count: z.number(),
  fork: z.boolean(),
  forks_count: z.number(),
  created_at: z.string().transform((dateString) =>
    Math.floor(new Date(dateString).getTime() / 1000)
  ),
  updated_at: z.string().transform((dateString) =>
    Math.floor(new Date(dateString).getTime() / 1000)
  ),
  pushed_at: z.string().transform((dateString) =>
    Math.floor(new Date(dateString).getTime() / 1000)
  ),
  license: z.object({
    spdx_id: z.string(),
  }).nullish(),
  homepage: z.string().nullish(),
  default_branch: z.string(),
}).transform((
  { owner, license, stargazers_count, forks_count, homepage, fork, ...rest },
) => ({
  owner: owner.login,
  license: license?.spdx_id || null,
  stars: stargazers_count,
  forks: forks_count,
  homepage: homepage || null,
  is_fork: fork,
  ...rest,
}));

const SchemaRepoCodeberg = z.object({
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  description: z.string().nullish(),
  language: z.string().nullish(),
  stars_count: z.number(),
  fork: z.boolean(),
  forks_count: z.number(),
  created_at: z.string().transform((dateString) =>
    Math.floor(new Date(dateString).getTime() / 1000)
  ),
  updated_at: z.string().transform((dateString) =>
    Math.floor(new Date(dateString).getTime() / 1000)
  ),
  license: z.object({
    spdx_id: z.string(),
  }).nullish(),
  homepage: z.string().nullish(),
  default_branch: z.string(),
}).transform((
  {
    full_name,
    owner,
    license,
    stars_count,
    forks_count,
    homepage,
    fork,
    updated_at,
    ...rest
  },
) => ({
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
}));

/**
 * @param {z.infer<typeof SchemaRepo>[]} parsed
 */
const zigReposInsert = (parsed) => {
  const stmt = db.prepare(`
    INSERT INTO zig_repos (
        full_name, name, owner, description, homepage, license, 
        created_at, updated_at, pushed_at, stars, forks, 
        is_fork, default_branch, language,
        min_zig_version, build_zig_exists, build_zig_fetched_at,
        build_zig_zon_exists, build_zig_zon_fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT(full_name) DO UPDATE SET
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
        default_branch = excluded.default_branch,
        language = excluded.language;
  `);
  const ftsStmt = db.prepare(`
    INSERT OR REPLACE INTO zig_repos_fts(full_name, name, owner, description)
    VALUES (?, ?, ?, ?);
  `);

  try {
    const upsertMany = db.transaction((data) => {
      for (const row of data) {
        stmt.run(row);
        ftsStmt.run(row[0], row[1], row[2], row[3]);
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

/**
 * invariants: github repo search api returns 1k items at most,
 * the interval between these weeks are handpicked to fetch the most stuff
 * while not crossing the 1k limit
 *
 * link produced by zigReposURLMake("all") eg.
 *
 * https://api.github.com/search/repositories?q=in%3Aname%2Cdescr
 * iption%2Ctopics%20zig%20created%3A2015-07-04T00%3A00%3A00Z..20
 * 17-09-02T00%3A00%3A00Z&per_page=100&page=1
 *
 * this is guaranteed to have 983 items, 113 weeks since zig init commit
 */
function createGetAllQuery() {
  // ziglang/zig commit 8e08cf4bec80b87a7a22a18086a3db5c2c0f1772
  // -1 day, just wanna make sure ziglang/zig is included
  const ZIG_INIT = new Date("2015-07-04");

  const weeksSinceInit = [
    113,
    188,
    236,
    268,
    295,
    317,
    337,
    354,
    369,
    385,
    399,
    411,
    421,
    430,
    439,
    446,
    454,
    461,
    467,
  ];

  let index = 0;
  let monthsAfterLast = 0;
  const last = addWeeks(
    ZIG_INIT,
    weeksSinceInit[weeksSinceInit.length - 1],
  );

  return function getAllQuery() {
    let query;

    // the hardcoded weeksSinceInit is guaranteed to return 1k items
    if (index < weeksSinceInit.length) {
      let start = ZIG_INIT;
      if (index > 0) start = addWeeks(ZIG_INIT, weeksSinceInit[index - 1]);
      const end = addWeeks(ZIG_INIT, weeksSinceInit[index]);
      const dateRange = makeDateRange(start, end);
      index++;
      query = `in:name,description,topics zig created:${dateRange}`;
    } else {
      const start = addMonths(last, monthsAfterLast);
      const end = addMonths(last, monthsAfterLast + 1);
      monthsAfterLast += 1;
      if (end > new Date()) {
        index = 0;
        monthsAfterLast = 0;
      }
      const dateRange = makeDateRange(start, end);
      query = `in:name,description,topics zig created:${dateRange}`;
    }
    return query;
  };
}
// defined here because it's stateful, footgun?
const getAllQuery = createGetAllQuery();

/**
 * @param {'top' | 'all' | 'codeberg:all'} type
 * @returns {string}
 */
const zigReposURLMake = (type) => {
  const isCodeberg = type.startsWith("codeberg:");
  const base = isCodeberg
    ? "https://codeberg.org/api/v1/repos/search"
    : "https://api.github.com/search/repositories";
  let query;

  if (type === "top") {
    query = "language:zig";
  } else if (type === "all" || type === "codeberg:all") {
    query = isCodeberg ? "zig" : getAllQuery();
  } else {
    logger.error(`zigReposURLMake - invalid type: ${type}`);
    fatal(`zigReposURLMake - invalid type ${typeof type}`);
  }

  // @ts-ignore - query is always defined
  const encodedQuery = encodeURIComponent(query);
  if (isCodeberg) {
    return `${base}?q=${encodedQuery}&includeDesc=true&page=1&limit=50`;
  }
  return `${base}?q=${encodedQuery}&per_page=100&page=1`;
};

/**
 * @param {string} url
 * @returns {Promise<{
 *   status: number,
 *   items: any[],
 *   next?: string,
 * }>}
 */
const zigReposFetch = async (url) => {
  const isCodeberg = url.startsWith("https://codeberg.org");
  const headers = isCodeberg ? codebergHeaders : githubHeaders;
  const response = await fetch(url, { headers: headers });
  let next;
  const linkHeader = response.headers.get("link");
  if (linkHeader) {
    const nextLink = linkHeader.split(",").find((part) =>
      part.includes('rel="next"')
    );
    next = nextLink?.match(/<(.*)>/)?.[1];
  }
  const data = await response.json();
  let items = isCodeberg ? data.data : data.items;
  items = Array.isArray(items) ? items.filter(Boolean) : [];
  return {
    status: response.status,
    items,
    next: next ? next : undefined,
  };
};

/**
 * @param {'top' | 'all' | 'codeberg:all'} type
 * @returns {Promise<void>}
 */
const zigReposFetchInsert = async (type) => {
  const isCodeberg = type.startsWith("codeberg:");

  /** @type {string | undefined} */
  let url = zigReposURLMake(type);
  const schema = isCodeberg ? SchemaRepoCodeberg : SchemaRepo;
  const schemaName = isCodeberg ? "SchemaRepoCodeberg" : "SchemaRepo";

  const parsed = [];
  while (url) {
    const res = await zigReposFetch(url);
    logger.info(`zigReposFetch - status ${res.status} - ${url}`);
    for (const item of res.items) {
      try {
        const parsedItem = schema.parse(item);
        parsed.push(parsedItem);
      } catch (e) {
        logger.error(`${schemaName}.parse`, {
          fullName: item.full_name,
          error: e,
        });
      }
    }
    url = res.next;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  zigReposInsert(parsed);
};

// https://github.com/ziglang/zig/blob/a931bfada5e358ace980b2f8fbc50ce424ced526/doc/build.zig.zon.md
//
// const url = "https://raw.githubusercontent.com/ziglang/zig/master/build.zig.zon"
// const response = await fetch(url)
// const parsed = SchemaZon.parse(JSON.parse(zon2json(await response.text())))
const SchemaZon = z.object({
  name: z.string(),
  version: z.string(),
  minimum_zig_version: z.string().optional(),
  paths: z.array(z.string()).optional(),
  dependencies: z.record(z.union([
    z.object({
      url: z.string(),
      hash: z.string(),
      lazy: z.boolean().optional(),
    }),
    z.object({
      path: z.string(),
      lazy: z.boolean().optional(),
    }),
  ])).optional(),
});

/**
 * @typedef {Object} RepoMetadata
 * @property {string} full_name
 * @property {string|undefined} min_zig_version
 * @property {boolean} buildZigExists
 * @property {boolean} zonExists
 * @property {number} fetchedAt
 */

/**
 * @param {RepoMetadata[]} parsed
 * @returns {void}
 */
const zigReposMetadataUpdate = (parsed) => {
  const stmt = db.prepare(`
    UPDATE zig_repos
    SET min_zig_version = ?,
        build_zig_exists = ?,
        build_zig_fetched_at = ?,
        build_zig_zon_exists = ?,
        build_zig_zon_fetched_at = ?
    WHERE full_name = ?
  `);

  try {
    const bulkUpdate = db.transaction((data) => {
      for (const row of data) {
        stmt.run(
          row.min_zig_version ?? null,
          row.buildZigExists,
          row.fetchedAt,
          row.zonExists,
          row.fetchedAt,
          row.full_name,
        );
      }
    });

    bulkUpdate(parsed);
    logger.info(`zig_repos zon bulk update - len ${parsed.length}`);
  } catch (e) {
    logger.error(`zig_repos zon bulk update - ${e}`);
  } finally {
    if (stmt) stmt.finalize();
  }
};

/**
 * @typedef {Object} UrlDependency
 * @property {string} hash
 * @property {string} name
 * @property {string} url
 */

/**
 * @param {UrlDependency[]} parsed
 * @returns {void}
 */
const urlDependenciesInsert = (parsed) => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO url_dependencies (hash, name, url)
    VALUES (?, ?, ?)
  `);

  try {
    const upsertMany = db.transaction((data) => {
      for (const row of data) {
        stmt.run(row);
      }
    });
    const rows = parsed.map((item) => [
      item.hash,
      item.name,
      item.url,
    ]);
    upsertMany(rows);
    logger.info(`url_dependencies bulk insert - len ${rows.length}`);
  } catch (e) {
    logger.error(`url_dependencies bulk insert - ${e}`);
  } finally {
    if (stmt) stmt.finalize();
  }
};

/**
 * @typedef {Object} ZigRepoDependency
 * @property {string} full_name
 * @property {string} name
 * @property {string} dependency_type
 * @property {string|null} path
 * @property {string|null} url_dependency_hash
 */

/**
 * @param {ZigRepoDependency[]} parsed
 * @returns {void}
 */
const zigRepoDependenciesInsert = (parsed) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO zig_repo_dependencies (
      full_name, name, dependency_type, path, url_dependency_hash
    ) VALUES (?, ?, ?, ?, ?)`);

  try {
    const upsertMany = db.transaction((data) => {
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

/**
 * @param {string} full_name
 * @param {string} default_branch
 * @param {'zon' | 'zig'} type
 * @returns {string}
 */
const zigBuildURLMake = (full_name, default_branch, type) => {
  const base = "https://raw.githubusercontent.com";
  let url = `${base}/${full_name}/${default_branch}`;
  if (type === "zon") {
    url = `${url}/build.zig.zon`;
  } else if (type === "zig") {
    url = `${url}/build.zig`;
  } else {
    logger.error(`zigBuildURLMake - invalid type: ${type}`);
    fatal(`zigBuildURLMake - invalid type ${typeof type}`);
  }
  return url;
};

/**
 * @param {string} url
 * @returns {Promise<{
 *  status: number,
 *  fetchedAt: number,
 *  content: string,
 *  }>}
 */
const zigBuildFetch = async (url) => {
  const response = await fetch(url);
  const fetchedAt = Math.floor(Date.now() / 1000);
  return {
    status: response.status,
    fetchedAt,
    content: await response.text(),
  };
};

const zigBuildFetchInsert = async () => {
  // rate limit: 5000 requests per hour, 83/min
  // 41 because fetching both build.zig and build.zig.zon, 41 * 2 = 82
  const stmt = db.prepare(`
    SELECT full_name, default_branch
    FROM zig_repos
    WHERE (
        build_zig_zon_fetched_at IS NULL
        OR (strftime('%s', 'now') - build_zig_zon_fetched_at) > 259200
    )
    AND full_name NOT LIKE '%zigbee%' COLLATE NOCASE
    AND (description IS NULL OR description NOT LIKE '%zigbee%' COLLATE NOCASE)
    ORDER BY stars DESC
    LIMIT 41;`);

  const repos = stmt.all();
  stmt.finalize();

  // not using zod here bc the incoming zon is already parsed, it's redundant
  /** @type {ZigRepoDependency[]} */
  const deps = [];
  /** @type {RepoMetadata[]} */
  const repoMetadata = [];
  /** @type {UrlDependency[]} */
  const urlDeps = [];

  await Promise.all(repos.map(async (repo) => {
    const url1 = zigBuildURLMake(repo.full_name, repo.default_branch, "zig");
    const res1 = await zigBuildFetch(url1);
    if (res1.status === 200 || res1.status === 404) {
      logger.info(
        `build.zig fetch - status ${res1.status} - ${repo.full_name}`,
      );
    } else {
      logger.warn(
        `build.zig fetch - status ${res1.status} - ${repo.full_name}`,
      );
    }

    const url = zigBuildURLMake(repo.full_name, repo.default_branch, "zon");
    const res = await zigBuildFetch(url);
    if (res.status === 200 || res.status === 404) {
      logger.info(
        `build.zig.zon fetch - status ${res.status} - ${repo.full_name}`,
      );
    } else {
      logger.warn(
        `build.zig.zon fetch - status ${res.status} - ${repo.full_name}`,
      );
    }

    let parsed;
    if (res.status === 200) {
      try {
        parsed = SchemaZon.parse(JSON.parse(zon2json(res.content)));
      } catch (e) {
        logger.error("SchemaZon.parse or zon2json", {
          fullName: repo.full_name,
          error: e,
        });
      }
    }

    repoMetadata.push({
      full_name: repo.full_name,
      min_zig_version: parsed?.minimum_zig_version,
      zonExists: res.status === 200,
      buildZigExists: res1.status === 200,
      fetchedAt: res.fetchedAt,
    });

    if (parsed?.dependencies) {
      Object.entries(parsed.dependencies).forEach(([name, dep]) => {
        if ("url" in dep && "hash" in dep) {
          deps.push({
            full_name: repo.full_name,
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
            full_name: repo.full_name,
            name: name,
            dependency_type: "path",
            path: dep.path,
            url_dependency_hash: null,
          });
        }
      });
    }
  }));

  if (repoMetadata.length > 0) zigReposMetadataUpdate(repoMetadata);
  if (urlDeps.length > 0) urlDependenciesInsert(urlDeps);
  if (deps.length > 0) zigRepoDependenciesInsert(deps);
};

const backup = async () => {
  const timestamp = new Date().toISOString().replace(/:/g, "_");
  try {
    const backupDB = new Database("./backup.sqlite");
    db.backup(backupDB);
    backupDB.close();
    await Deno.copyFile("./log.txt", "./log-backup.txt");
    logger.info("backed up db and log.txt locally");
  } catch (e) {
    logger.error(`error backing up db and log.txt: ${e}`);
  }

  try {
    const f1 = await Deno.readFile("./backup.sqlite");
    await R2.putObject(`backup-${timestamp}.sqlite`, f1, {
      metadata: { "Content-Type": "application/x-sqlite3" },
    });
    const f2 = await Deno.readFile("./log-backup.txt");
    await R2.putObject(`log-${timestamp}.txt`, f2, {
      metadata: { "Content-Type": "text/plain" },
    });

    logger.info("backed up db and log.txt to R2");
  } catch (e) {
    logger.error(`error backing up db and log.txt to R2: ${e}`);
  }

  try {
    await Deno.remove("./backup.sqlite");
    await Deno.remove("./log-backup.txt");
    logger.info("cleaned up backup files");
  } catch (e) {
    logger.error(`error cleaning up backup files: ${e}`);
  }
};

// ----------------------------------------------------------------------------
// main
// the moment the program is booted up, it should immediately crash if:
// - db not restored from backup (prod only)
// - db, r2, github api key not working
// - tailwind doesn't exist

// unrelated repos, but they have zig in their name/description
// TODO: SELECT count(*) FROM zig_repos WHERE LOWER(name) LIKE '%zigzag%' and language is not 'Zig';
// HELP: please add repos displayed by ziglist but not related to zig here!
const excludedRepos = [
  "manwar/perlweeklychallenge-club",
  "tighten/ziggy",
  "zigpy/zigpy-cli",
  "extism/extism",
  "xyproto/orbiton",
  "gojek/ziggurat",
  "jinyus/related_post_gen",
  "valdiney/zig",
  "CompVis/zigma",
  "Lisprez/so_stupid_search",
  "mercenaruss/zigstar_gateways",
  "zigpy/zigpy-znp",
  "christianhujer/expensereport",
  "beigirad/ZigzagView",
  "5zig-reborn/The-5zig-Mod",
  "KULeuven-MICAS/zigzag",
  "5zig/The-5zig-Mod",
  "zigi/zigi",
  "zigpy/zigpy-cc",
  "zigpy/zigpy-deconz",
  "xyzroe/ZigStarGW-FW",
  "doudz/zigate",
  "doudz/homeassistant-zigate",
  "ZigZag-Project/zigzag-v1",
  "coderDarren/ZigZagClone",
  "jeedom-zigate/jeedom-plugin-zigate",
  "isdrupter/ziggystartux",
  "artyang/ziggystartux",
  "ee7/binary-size",
  "codingonion/hello-algo-rust",
];

// some c/cpp projects use build.zig but doesn't mention zig in description
// HELP: please add c/cpp repos that builds with zig here!
const includedRepos = [
  "ggerganov/ggml",
  "trnxdev/onilang",
];

const logger = createLogger();
setInterval(() => {
  logger.flush();
}, 1000 * 10);

// on crash, for whatever reason
addEventListener("unload", () => {
  // should upload logs to R2
  logger.flush();
});

const IS_PROD = Deno.env.get("IS_PROD") !== undefined;
const IS_DEV = !IS_PROD;
logger.info(`running on ${IS_PROD ? "prod" : "dev"} mode`);

const GITHUB_API_KEY = Deno.env.get("GITHUB_API_KEY");
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${GITHUB_API_KEY}`,
};

const CODEBERG_API_KEY = Deno.env.get("CODEBERG_API_KEY");
if (!CODEBERG_API_KEY) fatal("CODEBERG_API_KEY is not set");
const codebergHeaders = {
  Authorization: `token ${CODEBERG_API_KEY}`,
};

const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
if (!R2_ENDPOINT) fatal("R2_ENDPOINT is not set");
if (!R2_ACCESS_KEY_ID) fatal("R2_ACCESS_KEY_ID is not set");
if (!R2_SECRET_ACCESS_KEY) fatal("R2_SECRET_ACCESS_KEY is not set");

const R2 = new S3Client({
  // @ts-ignore - R2 envs is guaranteed to be valid (fatal if not)
  endPoint: R2_ENDPOINT,
  port: 443,
  useSSL: true,
  region: "auto",
  bucket: "ziglist-backups",
  pathStyle: false,
  accessKey: R2_ACCESS_KEY_ID,
  secretKey: R2_SECRET_ACCESS_KEY,
});

// R2 healthcheck
if (IS_PROD) {
  const sqliteBackup = "backup-2024-08-16T00_00_00.002Z.sqlite";
  const resultR2 = await R2.getObject(sqliteBackup);
  try {
    const localOutFile = await Deno.open("db.sqlite", {
      write: true,
      createNew: true,
    });
    await resultR2.body?.pipeTo(localOutFile.writable);
    logger.info("healthcheck - restored db from R2");
  } catch (e) {
    fatal(`healthcheck - failed to restore db from R2 ${e}`);
  }
}

const db = new Database("db.sqlite");
db.exec(`
  PRAGMA journal_mode = WAL;
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
    language TEXT,
    min_zig_version TEXT,
    build_zig_exists BOOLEAN NULL,
    build_zig_fetched_at INTEGER NULL,
    build_zig_zon_exists BOOLEAN NULL,
    build_zig_zon_fetched_at INTEGER NULL
  );
  CREATE TABLE IF NOT EXISTS url_dependencies (
    hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS zig_repo_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    name TEXT NOT NULL,
    dependency_type TEXT CHECK(dependency_type IN ('url', 'path')) NOT NULL,
    path TEXT,
    url_dependency_hash TEXT,
    FOREIGN KEY (full_name) REFERENCES zig_repos (full_name),
    FOREIGN KEY (url_dependency_hash) REFERENCES url_dependencies (hash),
    UNIQUE(full_name, name, dependency_type, path)
    UNIQUE(full_name, name, dependency_type, url_dependency_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_zig_repos_pushed_at_stars_forks ON zig_repos(pushed_at DESC, stars, forks);
  CREATE INDEX IF NOT EXISTS idx_zig_repos_created_at_full_name ON zig_repos(created_at DESC, full_name);
  CREATE INDEX IF NOT EXISTS idx_zig_repos_forks_stars ON zig_repos(forks, stars DESC);
  CREATE INDEX IF NOT EXISTS idx_zig_repo_dependencies_full_name ON zig_repo_dependencies (full_name);

  -- Full text search
  DROP TABLE IF EXISTS zig_repos_fts;
  CREATE VIRTUAL TABLE IF NOT EXISTS zig_repos_fts USING fts5(
    owner, 
    name,
    full_name,
    description
  );
  INSERT INTO zig_repos_fts(full_name, name, owner, description)
    SELECT full_name, name, owner, description
    FROM zig_repos;
`);

// older Zig projects don't use zon files to list their dependencies
// so we need to manually insert them
// HELP: please add missing dependencies here!
db.exec(`PRAGMA foreign_keys = OFF;`);
try {
  db.exec(`
    INSERT OR IGNORE INTO zig_repo_dependencies (full_name, name, dependency_type, path)
    VALUES
      ('NilsIrl/dockerc', 'argp-standalone', 'path', 'argp-standalone'),
      ('NilsIrl/dockerc', 'crun', 'path', 'crun'),
      ('NilsIrl/dockerc', 'fuse-overlayfs', 'path', 'fuse-overlayfs'),
      ('NilsIrl/dockerc', 'libfuse', 'path', 'libfuse'),
      ('NilsIrl/dockerc', 'skopeo', 'path', 'skopeo'),
      ('NilsIrl/dockerc', 'squashfs-tools', 'path', 'squashfs-tools'),
      ('NilsIrl/dockerc', 'squashfuse', 'path', 'squashfuse'),
      ('NilsIrl/dockerc', 'umoci', 'path', 'umoci'),
      ('NilsIrl/dockerc', 'zstd', 'path', 'zstd'),
      ('zigzap/zap', 'facil.io', 'path', 'facil.io'),
      ('oven-sh/bun', 'boringssl', 'path', 'src/deps/boringssl'),
      ('oven-sh/bun', 'brotli', 'path', 'src/deps/brotli'),
      ('oven-sh/bun', 'c-ares', 'path', 'src/deps/c-ares'),
      ('oven-sh/bun', 'diffz', 'path', 'src/deps/diffz'),
      ('oven-sh/bun', 'libarchive', 'path', 'src/deps/libarchive'),
      ('oven-sh/bun', 'lol-html', 'path', 'src/deps/lol-html'),
      ('oven-sh/bun', 'ls-hpack', 'path', 'src/deps/ls-hpack'),
      ('oven-sh/bun', 'mimalloc', 'path', 'src/deps/mimalloc'),
      ('oven-sh/bun', 'patches', 'path', 'src/deps/patches'),
      ('oven-sh/bun', 'picohttpparser', 'path', 'src/deps/picohttpparser'),
      ('oven-sh/bun', 'tinycc', 'path', 'src/deps/tinycc'),
      ('oven-sh/bun', 'zig-clap', 'path', 'src/deps/zig-clap'),
      ('oven-sh/bun', 'zig', 'path', 'src/deps/zig'),
      ('oven-sh/bun', 'zlib', 'path', 'src/deps/zlib'),
      ('oven-sh/bun', 'zstd', 'path', 'src/deps/zstd'),
      ('oven-sh/bun', 'libuv', 'path', 'src/deps/libuv.zig'),
      ('oven-sh/bun', 'libdeflate', 'path', 'src/deps/libdeflate.zig'),
      ('oven-sh/bun', 'uSockets', 'path', 'bun/packages/bun-usockets'),
      ('oven-sh/bun', 'uWebsockets', 'path', 'bun/packages/bun-uws'),
      ('buzz-language/buzz', 'linenoise', 'path', 'vendor/linenoise'),
      ('buzz-language/buzz', 'mimalloc', 'path', 'vendor/mimalloc'),
      ('buzz-language/buzz', 'mir', 'path', 'vendor/mir'),
      ('buzz-language/buzz', 'pcre2', 'path', 'vendor/pcre2'),
      ('orhun/linuxwave', 'zig-clap', 'path', 'libs/zig-clap'),
      ('zfl9/chinadns-ng', 'wolfssl', 'path', 'dep/wolfssl'),
      ('zfl9/chinadns-ng', 'mimalloc', 'path', 'dep/mimalloc'),
      ('cztomsik/graffiti', 'emlay', 'path', 'deps/emlay'),
      ('cztomsik/graffiti', 'glfw', 'path', 'deps/glfw'),
      ('cztomsik/graffiti', 'nanovg-zig', 'path', 'deps/nanovg-zig'),
      ('cztomsik/graffiti', 'napigen', 'path', 'deps/napigen'),
      ('fubark/cyber', 'linenoise', 'path', 'lib/linenoise'),
      ('fubark/cyber', 'tcc', 'path', 'lib/tcc'),
      ('fubark/cyber', 'mimalloc', 'path', 'lib/mimalloc'),
      ('Vexu/bog', 'linenoize', 'path', 'lib/linenoize'),
      ('mewz-project/mewz', 'newlib', 'path', 'submodules/newlib'),
      ('mewz-project/mewz', 'lwip', 'path', 'submodules/lwip')
    `);
} finally {
  db.exec("PRAGMA foreign_keys = ON;");
}

fetch("https://api.github.com/zen", {
  headers: githubHeaders,
}).then(() => {
  logger.info("healthcheck - GITHUB_API_KEY is valid and usable");
}).catch((e) => {
  fatal(`healthcheck - GitHub API key is invalid: ${e}`);
});

fetch("https://codeberg.org/api/v1/repos/ziglings/exercises/commits?limit=1", {
  headers: codebergHeaders,
}).then(() => {
  logger.info("healthcheck - CODEBERG_API_KEY is valid and usable");
}).catch((e) => {
  fatal(`healthcheck - Codeberg API key is invalid: ${e}`);
});

try {
  db.prepare("SELECT COUNT(*) FROM zig_repos").get();
  logger.info("healthcheck - database is working");
} catch (e) {
  fatal(`healthcheck - database is not working: ${e}`);
}

let tailwindcss;
try {
  tailwindcss = Deno.readTextFileSync("./assets/tailwind.css");
  logger.info("healthcheck - tailwind.css is loaded");
} catch (e) {
  fatal(`healthcheck - tailwind.css is not loaded: ${e}`);
}

let popularDependencies;
const updatePopularDependencies = () => {
  const stmt = db.prepare(`
    WITH url_dependencies AS (
      SELECT 
        REPLACE(name, '-', '_') as normalized_name,
        COUNT(*) as url_dependency_count,
        COUNT(DISTINCT url_dependency_hash) as hash_version_count
      FROM zig_repo_dependencies
      WHERE dependency_type = 'url'
      GROUP BY normalized_name
    ),
    path_dependencies AS (
      SELECT 
        REPLACE(name, '-', '_') as normalized_name,
        COUNT(*) as path_dependency_count
      FROM zig_repo_dependencies
      WHERE dependency_type = 'path'
      GROUP BY normalized_name
    ),
    top_25_dependencies AS (
      SELECT 
        COALESCE(u.normalized_name, p.normalized_name) as normalized_name,
        COALESCE(u.url_dependency_count, 0) + COALESCE(p.path_dependency_count, 0) as total_dependency_count
      FROM url_dependencies u
      FULL OUTER JOIN path_dependencies p ON u.normalized_name = p.normalized_name
      ORDER BY total_dependency_count DESC
      LIMIT 20
    )
    SELECT 
      json_array(
        json_group_array(normalized_name)
      ) as json_names
    FROM top_25_dependencies;`);

  const result = stmt.all();
  stmt.finalize();
  const parsedData = typeof result === "string" ? JSON.parse(result) : result;
  popularDependencies = parsedData[0].json_names[0];
};
updatePopularDependencies();

const updateIncludedRepos = async () => {
  const parsedArr = [];
  for (const repo of includedRepos) {
    const url = `https://api.github.com/repos/${repo}`;
    try {
      const response = await fetch(url, { headers: githubHeaders });
      const data = await response.json();
      const parsed = SchemaRepo.parse(data);
      parsedArr.push(parsed);
    } catch (e) {
      logger.error("SchemaRepo.parse or fetch", {
        fullName: repo,
        error: e,
      });
    }
  }
  logger.info(`updateIncludedRepos - ${parsedArr.length} repos fetched`);
  zigReposInsert(parsedArr);
};

const port = 8080;
logger.info(`listening on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);

// updateIncludedRepos();
// zigBuildFetchInsert();
// Deno.cron("zigReposFetchInsert", "* * * * *", () => zigReposFetchInsert("all"));
// Deno.cron("zigBuildFetchInsert", "* * * * *", zigBuildFetchInsert);
// Deno.cron("updateIncludedRepos", "0 * * * *", updateIncludedRepos);
// Deno.cron("backup", "0 0,12 * * *", backup);
