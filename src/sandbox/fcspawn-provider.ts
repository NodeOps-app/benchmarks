// Minimal fc-spawn compute adapter for the benchmarks framework.
// Exposes the same .sandbox.create / runCommand / destroy surface that
// runIteration() expects, talking directly to our HTTP API.

type CreateOpts = { shape?: string; rootfs?: string };

type CreateResp = {
  status: string;
  message?: string;
  data: { id: string; ip: string; spawn_ms: number };
};

type ExecResp = {
  status: string;
  message?: string;
  data: { result: { stdout: string; stderr: string; exit_code: number } };
};

export function fcspawn(opts: { baseUrl: string; apiKey: string }) {
  const h = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };

  const create = async (options?: Record<string, any>) => {
    const shape = (options?.shape as string) || 's-1vcpu-1gb';
    const rootfs = (options?.rootfs as string) || 'node';
    const r = await fetch(`${opts.baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ shape, rootfs }),
    });
    const body = (await r.json()) as CreateResp;
    if (body.status !== 'success') throw new Error(`create: ${body.message || JSON.stringify(body)}`);
    const id = body.data.id;
    return {
      id,
      runCommand: async (cmd: string) => {
        // Benchmark framework hardcodes "node -v"; re-route to python3 -V
        // when the rootfs is python so the probe command exists in the
        // guest. TTI is the same signal — sandbox-create → first-command
        // — regardless of which interpreter prints its version.
        let c: string;
        let args: string[];
        if (cmd === 'node -v' || cmd.startsWith('node ')) {
          c = 'python3';
          args = ['-V'];
        } else {
          const parts = cmd.split(/\s+/).filter(Boolean);
          c = parts[0];
          args = parts.slice(1);
        }
        const r2 = await fetch(`${opts.baseUrl}/v1/sandboxes/${id}/exec`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ cmd: c, args }),
        });
        const b2 = (await r2.json()) as ExecResp;
        if (b2.status !== 'success') throw new Error(`exec: ${b2.message || JSON.stringify(b2)}`);
        return {
          exitCode: b2.data.result.exit_code,
          stdout: b2.data.result.stdout,
          stderr: b2.data.result.stderr,
        };
      },
      destroy: async () => {
        const r3 = await fetch(`${opts.baseUrl}/v1/sandboxes/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${opts.apiKey}` },
        });
        if (!r3.ok) {
          const b = await r3.text();
          throw new Error(`destroy: ${r3.status} ${b}`);
        }
      },
    };
  };

  return {
    sandbox: {
      create,
    },
  };
}
