import { Hono } from "hono";
import { db, kv, logger } from "./trunk.js";

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

// file generated by `npx tailwindcss`
const tailwindcss = Deno.readTextFileSync("./assets/tailwind.css");

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

// deno-lint-ignore no-unused-vars
const SpecialCard = () => {
  return (
    <div className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block hover:bg-stone-100 dark:hover:bg-stone-900 transition">
      <h3 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">
        codeberg/gitlab
      </h3>
      <p className="text-sm text-stone-700 dark:text-stone-300 mb-2">
        Codeberg and GitLab support coming soon!
      </p>
      <div className="flex-grow"></div>
    </div>
  );
};

const RepoCard = ({ repo }) => {
  return (
    <a
      href={`https://github.com/${repo.owner}/${repo.name}`}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-stone-50 dark:bg-stone-800 p-3 border border-stone-200 dark:border-stone-700 rounded-md flex flex-col block hover:bg-stone-100 dark:hover:bg-stone-900 transition"
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
          {repo.dependencies.slice(0, 5).map((dep, index) => (
            <Badge key={index} value={dep} />
          ))}
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

const RepoGrid = ({ repos }) => {
  const repoElements = repos.map((repo) => (
    <RepoCard key={repo.id} repo={repo} />
  ));
  // repoElements.splice(2, 0, <SpecialCard key="special" />);
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

app.get("/", async (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT *
    FROM zigrepos
    WHERE stars >= 10 AND forks >= 10
    ORDER BY pushed_at DESC
    LIMIT ? OFFSET ?
  `);
  let repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos = await Promise.all(repos.map(async (repo) => {
    const metadata = await kv.get([repo.full_name, "metadata"]);
    return {
      ...repo,
      minZigVersion: metadata.value?.minZigVersion,
      dependencies: metadata.value?.dependencies,
    };
  }));

  const isKv = (repo) => repo.minZigVersion || repo.dependencies?.length > 0;
  const kvFetched = repos.filter(isKv);

  const path = `GET /?page=${page}`;
  logger.log(
    "info",
    `${path} - ${repos.length} from db, ${kvFetched.length} from kv`,
  );
  return c.html(
    <BaseLayout currentPath="/" page={page}>
      <RepoGrid repos={Object.values(repos)} />
    </BaseLayout>,
  );
});

app.get("/new", async (c) => {
  const perPage = 30;
  const page = parseInt(c.req.query("page") || "1", 10);
  const offset = (page - 1) * perPage;
  const stmt = db.prepare(`
    SELECT *
    FROM zigrepos
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  let repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos = await Promise.all(repos.map(async (repo) => {
    const metadata = await kv.get([repo.full_name, "metadata"]);
    return {
      ...repo,
      minZigVersion: metadata.value?.minZigVersion,
      dependencies: metadata.value?.dependencies,
    };
  }));

  const isKv = (repo) => repo.minZigVersion || repo.dependencies?.length > 0;
  const kvFetched = repos.filter(isKv);

  const path = `GET /new?page=${page}`;
  logger.log(
    "info",
    `${path} - ${repos.length} from db, ${kvFetched.length} from kv`,
  );
  return c.html(
    <BaseLayout currentPath="/new" page={page}>
      <RepoGrid repos={Object.values(repos)} />
    </BaseLayout>,
  );
});

app.get("/top", async (c) => {
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
  let repos = stmt.all(perPage, offset);
  stmt.finalize();

  repos = await Promise.all(repos.map(async (repo) => {
    const metadata = await kv.get([repo.full_name, "metadata"]);
    return {
      ...repo,
      minZigVersion: metadata.value?.minZigVersion,
      dependencies: metadata.value?.dependencies,
    };
  }));

  const isKv = (repo) => repo.minZigVersion || repo.dependencies?.length > 0;
  const kvFetched = repos.filter(isKv);

  const path = `GET /top?page=${page}`;
  logger.log(
    "info",
    `${path} - ${repos.length} from db, ${kvFetched.length} from kv`,
  );
  return c.html(
    <BaseLayout currentPath="/top" page={page}>
      <RepoGrid repos={Object.values(repos)} />
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
