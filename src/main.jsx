import "@std/dotenv/load";
import { Database } from "sqlite";
import { Hono } from "hono";
import { z } from "zod";

// ----------------------------------------------------------------------------
// utils

/**
 * Creates a logger object with log and flush methods.
 * @typedef {('info' | 'error' | 'warn' | 'debug' | 'fatal')} LogLevel
 *
 * @returns {{
 *   log: (level: LogLevel, message: string, data?: any) => void,
 *   flush: () => Promise<void>
 * }} An object with log and flush methods.
 */
const createLogger = () => {
  let buffer = [];
  return {
    /**
     * Logs a message with optional data.
     * @param {LogLevel} level - The log level (e.g., 'info', 'error').
     * @param {string} message - The log message.
     * @param {*} [data] - Optional data to log.
     */
    log(level, message, data) {
      const now = new Date().toISOString();
      const msg = `${now} ${level.toUpperCase()}: ${message}`;
      if (data !== undefined) {
        buffer.push(`${msg} ${JSON.stringify(data)}`);
        console.log(msg, data);
      } else {
        buffer.push(msg);
        console.log(msg);
      }
    },
    /**
     * Flushes the log buffer to a file.
     * @returns {Promise<void>}
     */
    async flush() {
      if (buffer.length === 0) return;
      const bufStr = buffer.join("\n") + "\n";
      await Deno.writeTextFile("log.txt", bufStr, { append: true });
      buffer = [];
    },
  };
};

const logger = createLogger();
const db = new Database("db.sqlite");
const workerRepoFetch = await Deno.openKv(":memory:");

/**
 * Crashes the program with an error message.
 *
 * A wise man once said:
 * Runtime crashes are better than bugs.
 * Compile errors are better than runtime crashes.
 *
 * @param {string} message - Error message to log.
 * @param {Object} [data] - Additional data to log (optional).
 */
const fatal = (message, data) => {
  logger.log("fatal", message, data);
  logger.flush().then(() => {
    Deno.exit(1);
  });
};

/**
 * Creates repo search URL for the given date range and page on GitHub.
 * https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories
 *
 * @param {Date} start
 * @param {Date} end
 * @param {number} page
 * @returns {string}
 */
const makeReposURL = (start, end, page) => {
  const base = "https://api.github.com/search/repositories";
  const dateRange = `${start.toISOString().slice(0, 19)}Z..${
    end.toISOString().slice(0, 19)
  }Z`;
  const query = `in:name,description,topics zig created:${dateRange}`;
  const encodedQuery = encodeURIComponent(query);
  return `${base}?q=${encodedQuery}&per_page=100&page=${page}`;
};

const makeZonURL = ([repo, branch]) =>
  `https://raw.githubusercontent.com/${repo}/${branch}/build.zig.zon`;

/**
 * Extracts data from a build.zig.zon file.
 * TODO: untested
 *
 * https://github.com/ziglang/zig/blob/a931bfada5e358ace980b2f8fbc50ce424ced526/doc/build.zig.zon.md
 *
 * @param {string} zon - The contents of the zon file.
 */
function zon2json(zon) {
  return zon
    .replace(/(?<!:)\/\/.*$/gm, "")
    .replace(/\.\{""}/g, ".{}")
    .replace(/.{/g, "{")
    .replace(/.@"(\w+(?:-\w+)*)"?\s*=\s*/g, '"$1": ')
    .replace(/.(\w+)\s*=\s*/g, '"$1": ')
    .replace(/("paths"\s*:\s*){([^}]*)}/g, "$1[$2]")
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * TODO: deps hash should be the pk btw, not the name
 *
 * Initializes the SQLite database.
 *
 * @returns {void}
 */
const initDatabase = () => {
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`
    create table if not exists zigrepos (
      full_name text primary key,
      name text,
      owner text,
      description text null,
      homepage text null,
      license text null,
      created_at integer,
      updated_at integer,
      pushed_at integer,
      stars integer,
      forks integer,
      default_branch text,
      html_url text,
      language text,

      build_zig_exists boolean null,
      build_zig_fetched_at integer null,
      build_zig_zon_exists boolean null,
      build_zig_zon_fetched_at integer null
    )`);
  db.exec(`
    create table if not exists dependencies (
      id integer primary key autoincrement,
      repo_full_name text,
      depends_on text,
      foreign key (repo_full_name) references zigrepos (full_name),
      foreign key (depends_on) references zigrepos (full_name)
    )`);
};

const dependenciesMap = [
  { fullName: "zigzap/zap", dependencies: ["facil.io"] },
  {
    fullName: "oven-sh/bun",
    dependencies: [
      "boringssl",
      "brotli",
      "c-ares",
      "diffz",
      "libarchive",
      "lol-html",
      "ls-hpack",
      "mimalloc",
      "patches",
      "picohttpparser",
      "tinycc",
      "zig-clap",
      "zig",
      "zlib",
      "zstd",
    ],
  },
  {
    fullName: "buzz-language/buzz",
    dependencies: ["linenoise", "mimalloc", "mir", "pcre2"],
  },
  { fullName: "orhun/linuxwave", dependencies: ["zig-clap"] },
];

const GITHUB_API_KEY = Deno.env.get("GITHUB_API_KEY");
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${GITHUB_API_KEY}`,
};

const healthcheckGithub = async () => {
  try {
    const _ = await fetch("https://api.github.com/zen", {
      headers: githubHeaders,
    });
    logger.log("info", "GITHUB_API_KEY is valid and usable");
  } catch (e) {
    fatal(`GitHub API key is invalid: ${e}`);
  }
};

const healthcheckDb = () => {
  try {
    const _ = db.prepare("SELECT COUNT(*) FROM zigrepos").get();
    logger.log("info", "database is working");
  } catch (e) {
    fatal(e);
  }
};

const healthcheckRepoFetch = async () => {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const url = makeReposURL(start, now, 1);
  await workerRepoFetch.enqueue(url);
  // TODO: fatal this if things go wrong
};

// should crash if any of the healthchecks fail
initDatabase();
await healthcheckGithub();
healthcheckDb();
healthcheckRepoFetch();

const IS_PROD = Deno.env.get("IS_PROD") !== undefined;
logger.log("info", `running on ${IS_PROD ? "prod" : "dev"} mode`);

// ----------------------------------------------------------------------------
// jsx components
// note: this is not React, jsx is only for templating

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

const timeAgo = (timestamp) => {
  const moment = (new Date()).getTime() / 1000;
  const diff = moment - timestamp;
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

const Badge = ({ value }) => (
  <span className="p-0.5 bg-[#eeedec] text-stone-500 dark:bg-[#363230] dark:text-stone-400 rounded-sm text-xs inline-block">
    {value}
  </span>
);

const RepoDetail = ({ kind, value }) => (
  <div className="flex">
    <span className="text-sm text-stone-500 dark:text-stone-400">{kind}</span>
    <div className="flex-grow flex flex-col px-3">
      <div className="h-1/2 border-b border-stone-200 dark:border-stone-700">
      </div>
      <div className="h-1/2 border-t border-stone-200 dark:border-stone-700">
      </div>
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
      <div className="flex-grow"></div>
      <a
        href="https://github.com/pixqc/ziglist/issues"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block w-full text-center text-xs py-1.5 bg-[#eeedec] dark:bg-[#363230] text-stone-800 dark:text-stone-200 rounded-md hover:bg-stone-300 dark:hover:bg-stone-600 transition-colors"
      >
        GitHub Issues
      </a>
    </div>
  );
};

const RepoCard = ({ repo }) => {
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
      <div className="flex-grow"></div>
      {repo.dependencies && repo.dependencies.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-sm text-stone-500 dark:text-stone-400">
            Deps:
          </span>
          {repo.dependencies.slice(0, 5).map((dep) => <Badge value={dep} />)}
          {repo.dependencies.length > 5 && (
            <span className="text-sm text-stone-500 dark:text-stone-400">
              +{repo.dependencies.length - 5} more
            </span>
          )}
        </div>
      )}
      {repo.minZigVersion && (
        <RepoDetail
          kind="Min Zig"
          value={repo.minZigVersion.split("+")[0]}
        />
      )}
      <RepoDetail kind="Stars" value={repo.stars} />
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
    <div className="max-w-4xl mx-auto p-3 flex items-center justify-between">
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

const Navigation = ({ currentPath }) => {
  const textActive = "text-stone-900 dark:text-stone-100";
  const textDisabled = "text-stone-400 dark:text-stone-500";
  const linkStyle =
    "hover:text-stone-900 dark:hover:text-stone-100 transition-colors";

  return (
    <div className="max-w-4xl mx-auto px-3 flex space-x-4">
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

      <div className="flex-grow flex flex-col">
        <div className="h-1/2 border-b border-stone-100 dark:border-stone-800">
        </div>
        <div className="h-1/2 border-t border-stone-100 dark:border-stone-800">
        </div>
      </div>
    </div>
  );
};

const Pagination = ({ currentPath, page }) => {
  const prevPage = Math.max(1, page - 1);
  const nextPage = page + 1;
  const linkStyles =
    "px-2 py-2 flex items-center text-stone-400 dark:text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition-colors";

  return (
    <nav className="flex justify-center mb-6">
      <div className="flex items-center space-x-4">
        <a
          href={`${currentPath}?page=${prevPage}`}
          className={`${linkStyles} ${
            page === 1 ? "pointer-events-none opacity-50" : ""
          }`}
          aria-disabled={page === 1}
        >
          <LucideChevronLeft />
          Prev
        </a>
        <a
          href={`${currentPath}?page=${nextPage}`}
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
  <div className="flex max-w-4xl mx-auto px-3 mb-6 space-x-4 items-center">
    <div className="flex-grow flex flex-col">
      <div className="h-1/2 border-b border-stone-100 dark:border-stone-800">
      </div>
      <div className="h-1/2 border-t border-stone-100 dark:border-stone-800">
      </div>
    </div>
    <p className="text-stone-400 dark:text-stone-500 text-sm">
      ziglist.org by{"  "}
      <a
        target="_blank"
        rel="noopener noreferrer"
        href="https://github.com/pixqc"
        className="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
      >
        @pixqc
      </a>
    </p>
  </div>
);

// file generated by `npx tailwindcss`
const tailwindcss = Deno.readTextFileSync("./assets/tailwind.css");

const BaseLayout = ({ children, currentPath, page }) => (
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
        <Header />
        <Hero />
        <Navigation currentPath={currentPath} />
        <div className="max-w-4xl mx-auto p-3 mb-6">
          <div id="repo-grid">
            {children}
          </div>
        </div>
        <Pagination page={page} currentPath={currentPath} />
        <Footer />
      </body>
    </html>
  </>
);

// ----------------------------------------------------------------------------
// routes

const app = new Hono();

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.log(
    "info",
    `${c.req.method} ${c.req.url} - ${c.res.status} - ${ms}ms`,
  );
});

app.get("/", (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = page === 1 ? 29 : 30;
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT *
    FROM zigrepos
    WHERE stars >= 10 AND forks >= 10
    ORDER BY pushed_at DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  const path = `GET /?page=${page}`;
  logger.log("info", `${path} - ${repos.length} from db`);
  return c.html(
    <BaseLayout currentPath="/" page={page}>
      <RepoGrid repos={Object.values(repos)} currentPath="/" page={page} />
    </BaseLayout>,
  );
});

app.get("/new", (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT *
    FROM zigrepos
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  const path = `GET /new?page=${page}`;
  logger.log("info", `${path} - ${repos.length} from db`);
  return c.html(
    <BaseLayout currentPath="/new" page={page}>
      <RepoGrid repos={Object.values(repos)} currentPath="/new" page={page} />
    </BaseLayout>,
  );
});

app.get("/top", (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT *
    FROM zigrepos
    WHERE forks >= 10
    ORDER BY stars DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  const path = `GET /top?page=${page}`;
  logger.log("info", `${path} - ${repos.length} from db`);
  return c.html(
    <BaseLayout currentPath="/top" page={page}>
      <RepoGrid repos={Object.values(repos)} currentPath="/top" page={page} />
    </BaseLayout>,
  );
});

const Page404 = () => (
  <p>
    404 page not found. Return to <a href="/">homepage</a>.
  </p>
);

app.notFound((c) => {
  return c.html(<Page404 />, 404);
});

const port = 8080;
logger.log("info", `listening on ${port}`);
Deno.serve({ port: 8080 }, app.fetch);

// ----------------------------------------------------------------------------
// schemas

const SchemaRepo = z.object({
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  description: z.string().nullish(),
  html_url: z.string(),
  language: z.string().nullish(),
  stargazers_count: z.number(),
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
  { owner, license, stargazers_count, forks_count, homepage, ...rest },
) => ({
  owner: owner.login,
  license: license?.spdx_id || null,
  stars: stargazers_count,
  forks: forks_count,
  homepage: homepage || null,
  ...rest,
}));

// ----------------------------------------------------------------------------
// indexer

Deno.cron("repo index hourly", "0 * * * *", async () => {
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const url = makeReposURL(start, now, 1);
  logger.log(
    "info",
    `repo hourly cron - ${start.toISOString()} - ${now.toISOString()}`,
  );
  await workerRepoFetch.enqueue(url);
});

const controller = new AbortController();
Deno.cron("repo index all", "* * * * *", {
  signal: controller.signal,
}, async () => {
  const zigInitDate = new Date("2015-07-04");
  const res = db.prepare("SELECT MIN(created_at) FROM zigrepos").get();
  const minCreatedAt = res && "MIN(created_at)" in res
    ? res["MIN(created_at)"]
    : null;
  const end = minCreatedAt ? new Date(Number(minCreatedAt) * 1000) : new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (end < zigInitDate) {
    logger.log("info", "repo index by date - done");
    controller.abort();
    return;
  }
  const url = makeReposURL(start, end, 1);
  logger.log(
    "info",
    `repo index by date - ${start.toISOString()} - ${end.toISOString()}`,
  );
  await workerRepoFetch.enqueue(url);
});

workerRepoFetch.listenQueue(async (url) => {
  const response = await fetch(url, { headers: githubHeaders });
  if (response.status === 403) {
    logger.log("info", `repo fetch - status 403 - ${url}`);

    const rateLimit = {
      limit: parseInt(response.headers.get("x-ratelimit-limit") || "5000"),
      remaining: parseInt(response.headers.get("x-ratelimit-remaining") || "0"),
      reset: parseInt(response.headers.get("x-ratelimit-reset") || "0"),
    };

    const now = Math.floor(Date.now() / 1000);
    const delaySeconds = Math.max(0, rateLimit.reset - now);
    const delayMs = delaySeconds * 1000;

    logger.log(
      "info",
      `repo fetch - retrying in ${delaySeconds} seconds - ${url}`,
    );
    workerRepoFetch.enqueue(url, { delay: delayMs });
    return;
  }

  // github returns next page in link header
  const linkHeader = response.headers.get("link");
  if (linkHeader) {
    const nextLink = linkHeader.split(",").find((part) =>
      part.includes('rel="next"')
    );
    const next = nextLink?.match(/<(.*)>/)?.[1];
    if (next !== undefined) workerRepoFetch.enqueue(next, { delay: 1000 });
  }

  const data = await response.json();
  const items = data.items.filter(Boolean);
  logger.log("info", `repo fetch - status 200 - len ${items.length} - ${url}`);
  const parsed = items.map(SchemaRepo.parse);

  const insertQuery = `
    INSERT OR REPLACE INTO zigrepos (
      name, owner, full_name, description, homepage, license,
      created_at, updated_at, pushed_at, stars, forks, default_branch,
      html_url, language
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `;
  const stmt = db.prepare(insertQuery);
  const upsertMany = db.transaction((data) => {
    for (const row of data) {
      stmt.run(row);
    }
  });

  try {
    const rows = parsed.map((item) => [
      item.name,
      item.owner,
      item.full_name,
      item.description,
      item.homepage,
      item.license,
      item.created_at,
      item.updated_at,
      item.pushed_at,
      item.stars,
      item.forks,
      item.default_branch,
      item.html_url,
      item.language,
    ]);

    upsertMany(rows);
    logger.log("info", `repo bulk insert - len ${rows.length}`);
  } catch (error) {
    logger.log("error", `repo bulk insert - ${error}`);
  } finally {
    stmt.finalize();
  }
});

logger.log("info", "indexer started");

setInterval(async () => {
  await logger.flush();
}, 10 * 1000);
