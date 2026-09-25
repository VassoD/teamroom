import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { memberNameSchema, roomIdSchema } from "../core/schemas.js";
import { ConfigError } from "./errors.js";

/**
 * Lives inside the git common dir: never committed, and shared by every
 * worktree of the repo so agents in each worktree use the same membership.
 */
export const CONFIG_FILE_NAME = "teamroom.json";

export const ENV = {
  server: "TEAMROOM_SERVER",
  room: "TEAMROOM_ROOM",
  member: "TEAMROOM_MEMBER",
  token: "TEAMROOM_TOKEN",
  session: "TEAMROOM_SESSION",
} as const;

const configSchema = z.object({
  server: z.url(),
  roomId: roomIdSchema,
  member: memberNameSchema,
  token: z.string().min(1),
});

export type TeamroomConfig = z.infer<typeof configSchema>;

export function configPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, CONFIG_FILE_NAME);
}

/** Environment variables win over the file, which lets CI or a shared agent box inject credentials. */
export async function loadConfig(gitCommonDir: string, env: NodeJS.ProcessEnv = process.env): Promise<TeamroomConfig> {
  const fromFile = await readConfigFile(configPath(gitCommonDir));
  const merged = {
    server: env[ENV.server] ?? fromFile?.server,
    roomId: env[ENV.room] ?? fromFile?.roomId,
    member: env[ENV.member] ?? fromFile?.member,
    token: env[ENV.token] ?? fromFile?.token,
  };
  if (!merged.roomId || !merged.token) {
    throw new ConfigError("This repo is not in a teamroom yet. Run `teamroom create` or `teamroom join` first.");
  }
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new ConfigError(`The teamroom config is invalid (${fields}). Run \`teamroom join\` again to fix it.`);
  }
  return parsed.data;
}

export async function saveConfig(gitCommonDir: string, config: TeamroomConfig): Promise<string> {
  const target = configPath(gitCommonDir);
  const temp = `${target}.${process.pid}.tmp`;
  // The token grants write access to the room, so keep it readable by the owner only.
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
  return target;
}

async function readConfigFile(file: string): Promise<Partial<TeamroomConfig> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Could not read ${file}.`);
  }
  try {
    return configSchema.partial().parse(JSON.parse(raw));
  } catch {
    throw new ConfigError(`${file} is not valid teamroom config. Delete it and run \`teamroom join\` again.`);
  }
}
