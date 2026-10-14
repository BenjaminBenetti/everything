import net from "node:net";

/** True when something accepts connections on the unix socket path or loopback port. */
export function accepts(target: string | number): Promise<boolean> {
  return new Promise((resolve) => {
    const connection =
      typeof target === "string"
        ? net.connect(target)
        : net.connect(target, "127.0.0.1");
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => resolve(false));
  });
}
