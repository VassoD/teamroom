import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeListenError, startServer } from "../src/server/serve.js";

const LOCAL = { host: "127.0.0.1", port: 8787 };

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen ${code}`), { code });
}

describe("describeListenError", () => {
  it("should explain a port that is already taken and suggest the next one", () => {
    const message = describeListenError(errnoError("EADDRINUSE"), LOCAL);
    expect(message).toContain("Port 8787 is already in use on 127.0.0.1");
    expect(message).toContain("curl http://127.0.0.1:8787/health");
    expect(message).toContain("--port 8788");
  });

  it("should explain privileged ports", () => {
    expect(describeListenError(errnoError("EACCES"), { host: "0.0.0.0", port: 80 })).toContain(
      "Port 80 needs administrator rights"
    );
  });

  it("should explain a host that is not on this machine", () => {
    expect(describeListenError(errnoError("EADDRNOTAVAIL"), { host: "10.9.9.9", port: 8787 })).toContain(
      "--host 0.0.0.0"
    );
  });

  it("should leave unexpected errors alone", () => {
    expect(describeListenError(errnoError("EMFILE"), LOCAL)).toBeUndefined();
    expect(describeListenError(new Error("boom"), LOCAL)).toBeUndefined();
  });
});

describe("startServer on a busy port", () => {
  let blocker: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    blocker = undefined;
    dataDir = undefined;
  });

  it("should report the error through the handler instead of crashing", async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker?.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;
    dataDir = await mkdtemp(path.join(os.tmpdir(), "teamroom-serve-"));

    const error = await new Promise<Error>((resolve) => {
      startServer({ port, host: "127.0.0.1", dataDir: dataDir as string, trustProxy: false }, resolve);
    });

    expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    expect(describeListenError(error, { host: "127.0.0.1", port })).toContain(`Port ${port} is already in use`);
  });
});
