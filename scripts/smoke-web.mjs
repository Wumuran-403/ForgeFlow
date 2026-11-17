const baseUrl = process.env.SMOKE_BASE_URL;
const origin = process.env.SMOKE_ORIGIN;
const existingTaskId = process.env.SMOKE_TASK_ID;
if (!baseUrl || !origin) {
  process.stderr.write("Set SMOKE_BASE_URL and SMOKE_ORIGIN.\n");
  process.exit(2);
}

async function request(path, { method = "GET", cookie, body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      "x-forgeflow-client": "web",
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { origin, "content-type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

const page = await fetch(baseUrl);
if (!page.ok || !(await page.text()).includes("ForgeFlow")) throw new Error("Frontend unavailable");
const health = await request("/api/health");
if (health.response.status !== 200) throw new Error("Health check failed");
const denied = await request("/api/tasks");
if (denied.response.status !== 401) throw new Error("Unauthenticated task access was not denied");
const internal = await fetch(new URL("/internal/recovery-review/authenticate", baseUrl));
if (internal.status !== 404) throw new Error("Internal control route was exposed");
const session = await request("/api/auth/session");
if (session.response.status !== 200 || session.payload.data.kind !== "guest") {
  throw new Error("Guest session creation failed");
}
const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Guest session cookie missing");
let taskId = existingTaskId;

if (!taskId) {
  const created = await request("/api/tasks", {
    method: "POST", cookie,
    body: {
      workflowId: "stm32-bom-recovery",
      objective: "Inspect the STM32 BOM and inventory, then create a simulated draft after approval.",
      buildQuantity: 2_000,
    },
  });
  if (created.response.status !== 202) throw new Error("Task creation failed");
  taskId = created.payload.data.id;
  let approved = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await request(`/api/tasks/${taskId}`, { cookie });
    if (detail.response.status !== 200) throw new Error("Task polling failed");
    if (detail.payload.data.status === "completed") break;
    if (!approved) {
      const approvals = await request("/api/approvals", { cookie });
      const pending = approvals.payload.data.find((item) => item.taskId === taskId);
      if (pending) {
        const decision = await request(`/api/approvals/${pending.id}/approve`, {
          method: "POST", cookie, body: { reason: "Deployment smoke test" },
        });
        if (decision.response.status !== 200) throw new Error("Write approval failed");
        approved = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!approved) throw new Error("Approval was not reached");
}

const detail = await request(`/api/tasks/${taskId}`, { cookie });
if (detail.response.status !== 200 || detail.payload.data.status !== "completed") {
  throw new Error("Completed task was not readable");
}
const history = await request("/api/tasks", { cookie });
if (!history.payload.data.some((item) => item.id === taskId)) throw new Error("Task absent from history");
process.stdout.write(`Web smoke passed; taskId=${taskId}\n`);
