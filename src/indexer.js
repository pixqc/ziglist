import { z } from "zod";
import { db, GITHUB_API_KEY, kv, log } from "./trunk.js";

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
 * Returns a GitHub url that fetches repositories created between start and end
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
  return `${base}?q=${encodedQuery}&per_page=20&page=${page}`;
};

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
  await queueRepos.enqueue(url);
});

queueRepos.listenQueue(async (url) => {
  console.log(`fetching ${url}`);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${GITHUB_API_KEY}`,
  };

  const response = await fetch(url, { headers });
  if (response.status === 403) {
    queueRepos.enqueue(url, { delay: 60 * 60 * 1000 });
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
    console.log(`inserted into db: ${rows.length}`);
  } catch (error) {
    console.error("error in bulk insert:", error);
  } finally {
    stmt.finalize();

    const zonURLs = makeZonURLs(parsed.map((item) => item.full_name));
    zonURLs.slice(0, 5).map((url) => queueZon.enqueue(url));
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
  console.log(url);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${GITHUB_API_KEY}`,
  };
  const response = await fetch(url, { headers });

  if (response.status === 404) return;
  if (response.status === 403) {
    queueZon.enqueue(url, { delay: 60 * 60 * 1000 });
    return;
  }

  const data = await response.json();
  const parsed = SchemaFile.parse(data);
  await kv.set([parsed.fullName, "metadata"], extractZon(parsed.content));
});

log("info", "indexer started");
