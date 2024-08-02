import { z } from "zod";
import { db, GITHUB_API_KEY, kv, logger } from "./trunk.js";

const SchemaFile = z.object({
  name: z.string(),
  content: z.string().transform((content) => atob(content)),
  encoding: z.string(),
  url: z.string(),
}).transform(({ url, ...rest }) => {
  const parts = url.split("/");
  const repoOwner = parts[4];
  const repoName = parts[5];
  return {
    fullName: `${repoOwner}/${repoName}`,
    ...rest,
  };
});

const SchemaRepo = z.object({
  id: z.number(),
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
  { id, owner, license, stargazers_count, forks_count, homepage, ...rest },
) => ({
  repo_id: id,
  owner: owner.login,
  license: license?.spdx_id || null,
  stars: stargazers_count,
  forks: forks_count,
  homepage: homepage || null,
  ...rest,
}));

/**
 * Generates URLs for fetching Zig-related repositories from GitHub.
 * Date range is for avoiding rate limits.
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

/**
 * Generates URLs for fetching build.zig.zon files in GitHub repositories.
 *
 * @param {string[]} repos
 * @returns {string[]}
 */
const makeZonURLs = (repos) =>
  repos.map((repo) =>
    `https://api.github.com/repos/${repo}/contents/build.zig.zon`
  );

const queueZon = await Deno.openKv(":memory:");
const queueRepos = await Deno.openKv(":memory:");

Deno.cron("hourly index", "0 * * * *", async () => {
  const now = new Date();
  const start = new Date(now - 24 * 60 * 60 * 1000);
  const url = makeReposURL(start, now, 1);
  logger.log(
    "info",
    `cron indexer.js hourly - ${start.toISOString()} - ${now.toISOString()}`,
  );
  await queueRepos.enqueue(url);
});

Deno.cron("entire index", "* * * * *", async () => {
  const zigInitDate = new Date("2015-07-04");
  const res = db.prepare("SELECT MIN(created_at) FROM zigrepos").get();
  const end = res["MIN(created_at)"]
    ? new Date(res["MIN(created_at)"] * 1000)
    : new Date();
  const start = new Date(end - 30 * 24 * 60 * 60 * 1000);
  const url = makeReposURL(start, end, 1);
  logger.log(
    "info",
    `cron indexer.js by date - ${start.toISOString()} - ${end.toISOString()}`,
  );
  await queueRepos.enqueue(url);
});

queueRepos.listenQueue(async (url) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${GITHUB_API_KEY}`,
  };

  const response = await fetch(url, { headers });
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
    queueRepos.enqueue(url, { delay: delayMs });
    return;
  }

  // github returns next page in link header
  const linkHeader = response.headers.get("link");
  if (linkHeader) {
    const nextLink = linkHeader.split(",").find((part) =>
      part.includes('rel="next"')
    );
    const next = nextLink?.match(/<(.*)>/)?.[1];
    if (next !== undefined) queueRepos.enqueue(next, { delay: 1000 });
  }

  const data = await response.json();
  const items = data.items.filter(Boolean);
  logger.log("info", `repo fetch - status 200 - len ${items.length} - ${url}`);
  const parsed = items.map(SchemaRepo.parse);

  const insertQuery = `
    INSERT OR REPLACE INTO zigrepos (
      repo_id, name, owner, full_name, description, homepage, license,
      created_at, updated_at, pushed_at, stars, forks, default_branch,
      html_url, language
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      item.repo_id,
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

    const zonURLs = makeZonURLs(parsed.map((item) => item.full_name));
    logger.log("info", `queueing zon fetch - len ${zonURLs.length}`);
    zonURLs.map((url) => queueZon.enqueue(url));
  }
});

const extractZon = (zon) => {
  const zonWithoutComments = zon.replace(/\/\/.*$/gm, "");
  const minZigVersionMatch = zonWithoutComments.match(
    /\.minimum_zig_version\s*=\s*"([^"]+)"/,
  );
  const minZigVersion = minZigVersionMatch ? minZigVersionMatch[1] : undefined;

  const dependencies = [];
  const dependencyRegex = /\.(?:@"([^"]+)"|(\w+))(?=\s*=)/g;
  const excludedKeys = new Set([
    "name",
    "version",
    "paths",
    "dependencies",
    "hash",
    "lazy",
    "url",
    "path",
    "minimum_zig_version",
  ]);

  let match;
  while ((match = dependencyRegex.exec(zonWithoutComments)) !== null) {
    const dependency = match[1] || match[2];
    if (!excludedKeys.has(dependency)) {
      dependencies.push(dependency);
    }
  }

  return { dependencies, minZigVersion };
};

queueZon.listenQueue(async (url) => {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${GITHUB_API_KEY}`,
  };
  const response = await fetch(url, { headers });

  if (response.status === 404) {
    logger.log("info", `zon fetch - status 404 - ${url}`);
    return;
  }

  if (response.status === 403) {
    logger.log("info", `zon fetch - status 403 - ${url}`);

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
      `zon fetch - retrying in ${delaySeconds} seconds - ${url}`,
    );
    queueZon.enqueue(url, { delay: delayMs });
    return;
  }

  const data = await response.json();
  const parsed = SchemaFile.parse(data);
  logger.log("info", `zon fetch - status 200 - ${url}`);
  await kv.set([parsed.fullName, "metadata"], extractZon(parsed.content));
  logger.log("info", `zon insert kv - ${parsed.fullName}`);
});

logger.log("info", "indexer started");
