export async function GET() {
  return Response.json({
    ok: true,
    app: "scorefollow",
    phase: "2.1-full-port",
    vendor: "synpdf-rev194",
    ts: new Date().toISOString(),
  });
}
