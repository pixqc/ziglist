// db and .env exports
import "jsr:@std/dotenv/load";
import { Database } from "jsr:@db/sqlite@0.11";

const createLogger = () => {
  let buffer = [];
  return {
    log: (level, message, data) => {
      const now = new Date().toISOString();
      const msg = `${now} ${level.toUpperCase()}: ${message}`;
      if (data) {
        buffer.push(`${msg} ${JSON.stringify(data)}`);
        console.log(msg, data);
      } else {
        buffer.push(msg);
        console.log(msg);
      }
    },
    flush: async () => {
      const bufStr = buffer.join("\n") + "\n";
      await Deno.writeTextFile("log.txt", bufStr, { append: true });
      buffer = [];
    },
  };
};

export const logger = createLogger();
Deno.cron("flush logs", "* * * * *", async () => {
  logger.log("info", "flushing logs");
  await logger.flush();
});

// A wise man once said:
// Runtime crashes are better than bugs.
// Compile errors are better than runtime crashes.
export const fatal = (message) => {
  console.error(`fatal: ${message}`);
  Deno.exit(1);
};

export const GITHUB_API_KEY = Deno.env.get("GITHUB_API_KEY");
if (!GITHUB_API_KEY) fatal("GITHUB_API_KEY is not set");
logger.log("info", "GITHUB_API_KEY is set and exported");

export const IS_PROD = Deno.env.get("IS_PROD") !== undefined;
logger.log("info", `running on ${IS_PROD ? "prod" : "dev"} mode`);

export const kv = await Deno.openKv("db.sqlite");
export const db = new Database("db.sqlite");

db.exec(`
  create table if not exists zigrepos (
    id integer primary key autoincrement,
    repo_id integer unique,
    name text,
    owner text,
    full_name text,
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
    language text
  )
`);

// useful for making dependency graph, currently not used
db.exec(`
  create table if not exists dependencies (
    id integer primary key autoincrement,
    repo_id integer,
    dependency_repo_id integer,
    foreign key (repo_id) references zigrepos (id),
    foreign key (dependency_repo_id) references zigrepos (id)
  )
`);
logger.log("info", "database tables created");
