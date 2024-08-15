import "@std/dotenv/load";
import { S3Client } from "s3";

const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
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

const sqliteBackup = "backup-2024-08-13T03:00:00.002Z.sqlite";
const resultR2 = await R2.getObject(sqliteBackup);
const localOutFile = await Deno.open("db.sqlite", {
  write: true,
  createNew: true,
});
await resultR2.body?.pipeTo(localOutFile.writable);
