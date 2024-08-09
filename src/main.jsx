import "@std/dotenv/load";
import { Database } from "sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { S3Client } from "s3";

// ----------------------------------------------------------------------------
// utils

const SECONDLY = 1000;
const MINUTELY = 60 * SECONDLY;
const HOURLY = 60 * MINUTELY;
const DAILY = 24 * HOURLY;

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

const logger = createLogger();
setInterval(() => {
  logger.flush();
}, SECONDLY * 10);

/**
 * A wise man once said:
 * Runtime crashes are better than bugs.
 * Compile errors are better than runtime crashes.
 *
 * @param {string} message - Error message to log.
 * @param {Object} [data] - Additional data to log (optional).
 */
const fatal = (message, data) => {
  // TODO: should upload logs to R2
  logger.fatal(message, data);
  logger.flush().then(() => {
    Deno.exit(1);
  });
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
 * @param {Set<any>} set1
 * @param {Set<any>} set2
 * @returns {boolean}
 */
const setEqual = (set1, set2) => {
  return set1.size === set2.size && [...set1].every((item) => set2.has(item));
};

/**
 * https://github.com/ziglang/zig/blob/a931bfada5e358ace980b2f8fbc50ce424ced526/doc/build.zig.zon.md
 *
 * @param {string} zon - The contents of the zon file.
 */
function zon2json(zon) {
  return zon
    .replace(/(?<!:)\/\/.*$/gm, "") // Remove comments
    .replace(/\.\{""}/g, ".{}") // Handle empty objects
    .replace(/\.{/g, "{") // Replace leading dots before curly braces
    .replace(/\.@"([^"]+)"?\s*=\s*/g, '"$1": ') // Handle .@"key" = value
    .replace(/\.(\w+)\s*=\s*/g, '"$1": ') // Handle .key = value
    .replace(/("paths"\s*:\s*){([^}]*)}/g, "$1[$2]") // Convert paths to array
    .replace(/,(\s*[}\]])/g, "$1") // Remove trailing commas
    .replace(/"url"\s*:\s*"([^"]+)"/g, function (_, p1) {
      // Special handling for URL to preserve '?' and '#'
      return `"url": "${p1.replace(/"/g, '\\"')}"`;
    });
}

// ----------------------------------------------------------------------------
// inits and healthchecks

const db = new Database("from-fly.sqlite");

/**
 * @param {Database} innerDB
 * @returns {void}
 */
const initDatabase = (innerDB) => {
  innerDB.exec(`
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
      default_branch TEXT,
      language TEXT
    );
    CREATE TABLE IF NOT EXISTS zig_build_files (
      full_name TEXT,
      default_branch TEXT,
      build_zig_exists BOOLEAN NULL,
      build_zig_fetched_at INTEGER NULL,
      build_zig_zon_exists BOOLEAN NULL,
      build_zig_zon_fetched_at INTEGER NULL,
      PRIMARY KEY (full_name, default_branch),
      FOREIGN KEY (full_name) REFERENCES zig_repos (full_name)
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
      FOREIGN KEY (url_dependency_hash) REFERENCES url_dependencies (hash)
    );
    CREATE INDEX IF NOT EXISTS idx_zig_repos_pushed_at_stars_forks ON zig_repos(pushed_at DESC, stars, forks);
    CREATE INDEX IF NOT EXISTS idx_zig_repos_created_at_full_name ON zig_repos(created_at DESC, full_name);
    CREATE INDEX IF NOT EXISTS idx_zig_repos_forks_stars ON zig_repos(forks, stars DESC);
    CREATE INDEX IF NOT EXISTS idx_zig_repo_dependencies_full_name ON zig_repo_dependencies (full_name);
`);
};

/**
 * Older Zig projects don't use zon files to list their dependencies
 * so we need to manually insert them
 *
 * @param {Database} innerDB
 * @returns {void}
 */
const insertDependencies = (innerDB) => {
  // zfl9/chinadns-ng: wolfssl, mimalloc
  // cztomsik/graffiti: emlay, glfw, nanovg-zig, napigen
  // empty out ziglang/zig
  innerDB.exec(`
    INSERT INTO zig_repo_dependencies (full_name, name, dependency_type, path)
    VALUES ('zigzap/zap', 'facil.io', 'path', 'facil.io');

    INSERT INTO zig_repo_dependencies (full_name, name, dependency_type, path)
    VALUES
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
      ('oven-sh/bun', 'zstd', 'path', 'src/deps/zstd');

    INSERT INTO zig_repo_dependencies (full_name, name, dependency_type, path)
    VALUES
      ('buzz-language/buzz', 'linenoise', 'path', 'vendor/linenoise'),
      ('buzz-language/buzz', 'mimalloc', 'path', 'vendor/mimalloc'),
      ('buzz-language/buzz', 'mir', 'path', 'vendor/mir'),
      ('buzz-language/buzz', 'pcre2', 'path', 'vendor/pcre2');

    INSERT INTO zig_repo_dependencies (full_name, name, dependency_type, path)
    VALUES ('orhun/linuxwave', 'zig-clap', 'path', 'libs/zig-clap');`);
};

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

const healthcheckGithub = () => {
  fetch("https://api.github.com/zen", {
    headers: githubHeaders,
  }).then(() => {
    logger.info("healthcheck - GITHUB_API_KEY is valid and usable");
  }).catch((e) => {
    fatal(`healthcheck - GitHub API key is invalid: ${e}`);
  });
};

const healthcheckDatabase = () => {
  try {
    const _ = db.prepare("SELECT COUNT(*) FROM zig_repos").get();
    logger.info("healthcheck - database is working");
  } catch (e) {
    fatal(`healthcheck - database is not working: ${e}`);
  }
};

const healthcheckGithubFetch = async () => {
  const dummyDB = new Database("./test-db.sqlite");
  initDatabase(dummyDB);

  const base = "https://api.github.com/search/repositories";
  const query = `language:zig`;
  const encodedQuery = encodeURIComponent(query);
  const url = `${base}?q=${encodedQuery}&per_page=50&page=1`;
  const response = await fetch(url, { headers: githubHeaders });

  const data = await response.json();
  const items = data.items.filter(Boolean);
  const parsed = [];
  for (const item of items) {
    try {
      const parsedItem = SchemaRepo.parse(item);
      parsed.push(parsedItem);
    } catch (e) {
      logger.error("healthcheck - error parsing repos", {
        fullName: item.full_name,
        error: e,
      });
    }
  }

  if (parsed.length === 0) fatal("healthcheck - no repos fetched from GitHub");
  const repos = parsed.map((item) => {
    return { fullName: item.full_name, defaultBranch: item.default_branch };
  });

  const zons = await Promise.all(repos.map(fetchZon));

  zigReposInsert(dummyDB, parsed);
  dependenciesInsert(dummyDB, zons);

  const q1 = dummyDB.prepare(`
    SELECT full_name
    FROM zig_repos
  `);
  const r1 = q1.all().map((row) => row.full_name);
  q1.finalize();
  const s1 = new Set(r1);
  const s1Parsed = new Set(parsed.map((item) => item.full_name));
  console.log(s1);
  console.log(s1Parsed);
  if (!setEqual(s1, s1Parsed)) fatal("healthcheck - zig_repos mismatch");

  // set of url hashes

  // @ts-ignore - lmao who cares
  // const deps = zons.flatMap((zon) => zon.parsed?.dependencies).filter(Boolean);
};

let tailwindcss = "";
const healthcheckTailwind = () => {
  try {
    tailwindcss = Deno.readTextFileSync("./assets/tailwind.css");
    logger.info("healthcheck - tailwind.css is loaded");
  } catch (e) {
    fatal(`healthcheck - tailwind.css is not loaded: ${e}`);
  }
};

const healthcheckR2 = () => {
  const timestamp = new Date().toISOString();
  const opts = {
    "metadata": { "Content-Type": "text/plain" },
  };

  let contents = "";
  const writable = new WritableStream({
    write(chunk) {
      contents += new TextDecoder().decode(chunk);
    },
  });

  R2.putObject("test.txt", timestamp, opts)
    .then(() => R2.getObject("test.txt"))
    .then((response) => {
      return response.body?.pipeTo(writable)
        .then(() => contents);
    })
    .then((contents) => {
      if (contents !== timestamp) {
        fatal("healthcheck - R2 put/get failed");
      } else {
        logger.info("healthcheck - R2 works fine");
      }
    })
    .catch((error) => {
      fatal(`healthcheck - R2 put/get failed: ${error}`);
    });
};

initDatabase(db);

// should crash if any of the healthchecks fail
healthcheckGithub();
healthcheckDatabase();
// healthcheckGithubFetch();
// healthcheckR2();
healthcheckTailwind();

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
      <a
        href="/dependencies"
        className={`${linkStyle} ${
          currentPath === "/dependencies" ? textActive : textDisabled
        }`}
      >
        Deps
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
        <div className="max-w-4xl mx-auto px-3 py-6">
          <div>
            {children}
          </div>
        </div>
        {typeof page === "number" && page > 0 && (
          <Pagination page={page} currentPath={currentPath} />
        )}
        <Footer />
      </body>
    </html>
  </>
);

const DependencyList = ({ deps }) => {
  return (
    <div>
      {deps.map((repo, index) => (
        <div key={index} className="mb-6">
          <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">
            {repo.full_name}{" "}
            <span className="font-normal text-sm text-stone-400 dark:text-stone-500">
              depends on
            </span>
          </h3>
          <ul className="list-none p-0 m-0">
            {repo.dependencies.map((dep, depIndex) => (
              <li
                key={depIndex}
                className="text-sm text-stone-700 dark:text-stone-300 mb-0.5"
              >
                {dep.name}{" "}
                {dep.type === "url" && (
                  <span className="text-xs text-stone-400 dark:text-stone-500 break-all">
                    {dep.url}
                  </span>
                )}
                {dep.type === "path" && (
                  <span className="text-xs text-stone-400 dark:text-stone-500">
                    {dep.path}
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
      json_group_array(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE r.stars >= 10 AND r.forks >= 10
    GROUP BY r.full_name
    ORDER BY r.pushed_at DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos.forEach((repo) => {
    repo.dependencies = JSON.parse(repo.dependencies).filter((dep) =>
      dep !== null
    );
  });

  logger.info(`GET /?page=${page} - ${repos.length} from db`);
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
    SELECT
      r.*,
      json_group_array(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    GROUP BY r.full_name
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos.forEach((repo) => {
    repo.dependencies = JSON.parse(repo.dependencies).filter((dep) =>
      dep !== null
    );
  });

  logger.info(`GET /new?page=${page} - ${repos.length} from db`);
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
    SELECT
      r.*,
      json_group_array(d.name) AS dependencies
    FROM zig_repos r
    LEFT JOIN zig_repo_dependencies d ON r.full_name = d.full_name
    WHERE r.forks >= 10
    GROUP BY r.full_name
    ORDER BY r.stars DESC
    LIMIT ? OFFSET ?
  `);
  const repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos.forEach((repo) => {
    repo.dependencies = JSON.parse(repo.dependencies).filter((dep) =>
      dep !== null
    );
  });

  logger.info(`GET /top?page=${page} - ${repos.length} from db`);
  return c.html(
    <BaseLayout currentPath="/top" page={-1}>
      <RepoGrid repos={Object.values(repos)} currentPath="/top" page={page} />
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

  // -1 to hide pagination
  return c.html(
    <BaseLayout currentPath="/dependencies" page={-1}>
      <DependencyList deps={deps} />
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
logger.info(`listening on http://localhost:${port}`);
Deno.serve({ port: 8080 }, app.fetch);

// ----------------------------------------------------------------------------
// schemas

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

const SchemaRepo = z.object({
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  description: z.string().nullish(),
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
// workers

/**
 * @param {Database} innerDB
 * @param {z.infer<typeof SchemaRepo>[]} parsed
 */
const zigReposInsert = (innerDB, parsed) => {
  const stmt = innerDB.prepare(`
    INSERT OR REPLACE INTO zig_repos (
      full_name, name, owner, description, homepage, license, created_at,
      updated_at, pushed_at, stars, forks, default_branch, language
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  try {
    const upsertMany = innerDB.transaction((data) => {
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
 * @param {{ fullName: string, defaultBranch: string }} repo
 * @returns {Promise<{
 *   status: number,
 *   fetchedAt: number,
 *   fullName: string,
 *   defaultBranch: string,
 *   parsed?: z.infer<typeof SchemaZon>
 * }>}
 */
const fetchZon = async (repo) => {
  const url =
    `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/build.zig.zon`;
  const response = await fetch(url);
  const fetchedAt = Math.floor(Date.now() / 1000);
  const status = response.status;

  // not warning 404 because it's normal
  if (status === 200 || status === 404) {
    logger.info(`build.zig.zon fetch - status ${status} - ${repo.fullName}`);
  } else {
    logger.warn(`build.zig.zon fetch - status ${status} - ${repo.fullName}`);
  }

  let parsed;
  if (status === 200) {
    const contentRaw = await response.text();
    try {
      const content = JSON.parse(zon2json(contentRaw));
      parsed = SchemaZon.parse(content);
    } catch (e) {
      logger.error(`error parsing zon file:`, {
        fullName: repo.fullName,
        error: e,
      });
    }
  }

  return {
    status,
    fetchedAt,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    parsed,
  };
};

/**
 * @param {Database} innerDB
 * @param {{
 *   status: number,
 *   fetchedAt: number,
 *   fullName: string,
 *   defaultBranch: string,
 *   parsed?: z.infer<typeof SchemaZon>
 * }[]} fetchResults
 */
const dependenciesInsert = (innerDB, fetchResults) => {
  const stmt1 = innerDB.prepare(`
    INSERT OR REPLACE INTO zig_build_files (
      full_name, default_branch, build_zig_zon_exists, build_zig_zon_fetched_at
    ) VALUES (?, ?, ?, ?)`);
  const stmt2 = innerDB.prepare(`
    INSERT OR IGNORE INTO url_dependencies (hash, name, url)
    VALUES (?, ?, ?)`);
  const stmt3 = innerDB.prepare(`
    INSERT INTO zig_repo_dependencies (
      full_name, name, dependency_type, path, url_dependency_hash
    ) VALUES (?, ?, ?, ?, ?)`);

  let filesCount = 0;
  let urlDepsCount = 0;
  let repoDepsCount = 0;

  try {
    innerDB.transaction(() => {
      for (const zon of fetchResults) {
        stmt1.run(
          zon.fullName,
          zon.defaultBranch,
          zon.status === 200,
          zon.fetchedAt,
        );
        filesCount++;

        if (zon.parsed && zon.parsed.dependencies) {
          for (const [name, dep] of Object.entries(zon.parsed.dependencies)) {
            if ("url" in dep) {
              stmt2.run(dep.hash, name, dep.url);
              stmt3.run(zon.fullName, name, "url", null, dep.hash);
              urlDepsCount++;
              repoDepsCount++;
            } else if ("path" in dep) {
              stmt3.run(zon.fullName, name, "path", dep.path, null);
              repoDepsCount++;
            }
          }
        }
      }
      logger.info(`zig_build_files inserted: ${filesCount}`);
      logger.info(`url_dependencies inserted: ${urlDepsCount}`);
      logger.info(`zig_repo_dependencies inserted: ${repoDepsCount}`);
    })();
  } catch (e) {
    logger.error(`error inserting zig_build_files: ${e}`);
  } finally {
    stmt1.finalize();
    stmt2.finalize();
    stmt3.finalize();
  }
};

const workerRepoFetch = await Deno.openKv(":memory:");

// new stuff released last hour
setInterval(() => {
  const base = "https://api.github.com/search/repositories";
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const dateRange = makeDateRange(start, end);
  const query = `in:name,description,topics zig created:${dateRange}`;
  const encodedQuery = encodeURIComponent(query);
  const url = `${base}?q=${encodedQuery}&per_page=100&page=1`;
  workerRepoFetch.enqueue(url);
}, HOURLY);

// fetch all zig-related repos to the beginning of time
const zigReposInterval = setInterval(() => {
  const zigInitDate = new Date("2015-07-04");
  const base = "https://api.github.com/search/repositories";
  const res = db.prepare("SELECT MIN(created_at) FROM zig_repos").get();
  const minCreatedAt = res && "MIN(created_at)" in res
    ? res["MIN(created_at)"]
    : null;
  const end = minCreatedAt ? new Date(Number(minCreatedAt) * 1000) : new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (end < zigInitDate) {
    logger.info("zig_repos fetch to end");

    // popular repos, to make sure not missing any
    const encodedQuery = encodeURIComponent("language:zig");
    const url = `${base}?q=${encodedQuery}&per_page=100&page=1`;
    workerRepoFetch.enqueue(url);
    clearInterval(zigReposInterval);
  }
  // must use date because github's api only return the first 1k items
  const dateRange = makeDateRange(start, end);
  const query = `in:name,description,topics zig created:${dateRange}`;
  const encodedQuery = encodeURIComponent(query);
  const url = `${base}?q=${encodedQuery}&per_page=100&page=1`;
  workerRepoFetch.enqueue(url);
}, MINUTELY);

// repo search rate limit: 10 pages per minute
workerRepoFetch.listenQueue(async (url) => {
  const response = await fetch(url, { headers: githubHeaders });
  if (response.ok) {
    logger.info(`zig_repos fetch - ${response.status} - ${url}`);
  } else {
    logger.warn(`zig_repos fetch - ${response.status} - ${url}`);
  }

  if (response.status === 403) {
    const rateLimit = {
      limit: parseInt(response.headers.get("x-ratelimit-limit") || "5000"),
      remaining: parseInt(response.headers.get("x-ratelimit-remaining") || "0"),
      reset: parseInt(response.headers.get("x-ratelimit-reset") || "0"),
    };

    const now = Math.floor(Date.now() / 1000);
    const delaySeconds = Math.max(0, rateLimit.reset - now);
    const delayMs = delaySeconds * 1000;

    logger.warn(
      `zig_repos fetch - retrying in ${delaySeconds} seconds - ${url}`,
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
  const parsed = [];
  for (const item of items) {
    try {
      const parsedItem = SchemaRepo.parse(item);
      parsed.push(parsedItem);
    } catch (e) {
      logger.error("error parsing repos", {
        fullName: item.full_name,
        error: e,
      });
    }
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO zig_repos (
      full_name, name, owner, description, homepage, license, created_at,
      updated_at, pushed_at, stars, forks, default_branch, language
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  try {
    const upsertMany = db.transaction((data) => {
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

  // to be used later by zon and zig fetchers
  const stmt2 = db.prepare(`
    INSERT OR IGNORE INTO zig_build_files (full_name, default_branch)
    VALUES (?, ?)`);
  try {
    const upsertMany = db.transaction((data) => {
      for (const row of data) {
        stmt2.run(row);
      }
    });

    const rows = parsed.map((item) => [item.full_name, item.default_branch]);
    upsertMany(rows);
    logger.info(`zig_build_files bulk insert - len ${rows.length}`);
  } catch (e) {
    logger.error(`zig_build_files bulk insert - ${e}`);
  } finally {
    if (stmt2) stmt2.finalize();
  }
});

const zonFetchInterval = setInterval(async () => {
  // rate limit is 5000 per hour, 13 per minute
  const query = db.prepare(`
    SELECT full_name, default_branch
    FROM zig_build_files
    WHERE build_zig_zon_fetched_at IS NULL
    LIMIT 13;
  `);
  const repos = query.all();
  query.finalize();
  if (repos.length === 0) return;
  logger.info(`zig_build_files fetch - fetching ${repos.length} zon files`);

  const stmt1 = db.prepare(`
    INSERT OR REPLACE INTO zig_build_files (
      full_name, default_branch, build_zig_zon_exists, build_zig_zon_fetched_at
    ) VALUES (?, ?, ?, ?)`);
  const stmt2 = db.prepare(`
    INSERT OR IGNORE INTO url_dependencies (hash, name, url)
    VALUES (?, ?, ?)`);
  const stmt3 = db.prepare(`
    INSERT INTO zig_repo_dependencies (
      full_name, name, dependency_type, path, url_dependency_hash
    ) VALUES (?, ?, ?, ?, ?)`);

  // @ts-ignore repo type is Record<string, any>
  const zons = await Promise.all(repos.map(fetchZon));

  let filesCount = 0;
  let urlDepsCount = 0;
  let repoDepsCount = 0;

  try {
    db.transaction(() => {
      for (const zon of zons) {
        stmt1.run(
          zon.fullName,
          zon.defaultBranch,
          zon.status === 200,
          zon.fetchedAt,
        );
        filesCount++;

        if (zon.parsed && zon.parsed.dependencies) {
          for (const [name, dep] of Object.entries(zon.parsed.dependencies)) {
            if ("url" in dep) {
              stmt2.run(dep.hash, name, dep.url);
              stmt3.run(zon.fullName, name, "url", null, dep.hash);
              urlDepsCount++;
              repoDepsCount++;
            } else if ("path" in dep) {
              stmt3.run(zon.fullName, name, "path", dep.path, null);
              repoDepsCount++;
            }
          }
        }
      }
      logger.info(`zig_build_files inserted: ${filesCount}`);
      logger.info(`url_dependencies inserted: ${urlDepsCount}`);
      logger.info(`zig_repo_dependencies inserted: ${repoDepsCount}`);
    })();
  } catch (e) {
    logger.error(`error inserting zig_build_files: ${e}`);
  } finally {
    stmt1.finalize();
    stmt2.finalize();
    stmt3.finalize();
  }
}, SECONDLY * 10);

// ----------------------------------------------------------------------------
// backup db and log.txt

const backupInterval = setInterval(async () => {
  const timestamp = new Date().toISOString();
  try {
    const backupDB = new Database("./backup.sqlite");
    db.backup(backupDB);
    backupDB.close();
    Deno.copyFile("./log.txt", "./log-backup.txt");
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
}, HOURLY);

// ----------------------------------------------------------------------------
// flags
// this part could be better...

if (IS_DEV) {
  clearInterval(backupInterval);
  clearInterval(zigReposInterval);
  clearInterval(zonFetchInterval);
}
