export async function POST(request: Request) {
  const form = await request.formData();
  const payload = String(form.get("payload") ?? "");

  if (!payload) {
    return new Response("Missing project data", { status: 400 });
  }

  let projectName = "mujing-project";
  try {
    const project = JSON.parse(payload) as { projectName?: string };
    projectName = (project.projectName ?? projectName)
      .replace(/[\\/:*?"<>|\r\n]+/g, "-")
      .slice(0, 80) || projectName;
  } catch {
    return new Response("Invalid project data", { status: 400 });
  }

  const encodedName = encodeURIComponent(`${projectName}.story.json`);
  return new Response(payload, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="mujing-project.story.json"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
    },
  });
}
