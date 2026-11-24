/**
 * Prompt for the Memmy task that adds one agent to the collaboration side: it finds the folder that agent reads
 * skills from and installs `memmy-project` there. Memmy never reads that agent's own records, so nothing here
 * asks the task to describe a storage format.
 */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function buildCollabAgentConnectPrompt(agentName: string, skillDirectory?: string): string {
  const name = agentName.trim();
  const directory = skillDirectory?.trim() ?? "";
  return [
    `把本机的「${name}」添加为能使用协作项目的 Agent。`,
    "",
    "## 目标",
    `让「${name}」在自己的对话里能使用 memmy-project：检索协作项目中的任务，把当前任务加入项目。为此只需要把协作技能装进它读取技能的目录。这件事不需要、也不允许读取它的任务记录。`,
    "",
    ...(directory
      ? [`用户提供的技能目录：${directory}。先按第 2 步核对；核对不通过时告诉我原因，再按第 1、2 步自行查找。`, ""]
      : []),
    "## 成功条件",
    "以下两条全部满足，才算添加完成：",
    `1. 已找到「${name}」实际读取技能的目录。这个目录原本就存在，并且能说明它属于「${name}」的依据。`,
    "2. 第 3 步的添加命令输出「已添加」。",
    "",
    "## 步骤",
    "1. 找到它的配置目录",
    "   - 只找配置目录，不需要找程序安装在哪里。",
    "   - 先查常见位置。多数 Agent 无论程序装在哪里，配置都放在用户目录下：",
    "     - 所有系统：~/.<名称>、~/.config/<名称>",
    "     - macOS：~/Library/Application Support/<名称>",
    "     - Windows：%USERPROFILE%\\.<名称>、%APPDATA%\\<名称>、%LOCALAPPDATA%\\<名称>",
    "   - 常见位置找不到时，再扩大范围，方法不限，例如：",
    "     - 它正在运行时，从进程的程序路径找到所在目录。便携安装的配置可能就在程序旁边。",
    "     - 查它的官方文档、帮助命令或设置中写明的配置位置。",
    "     - 在用户目录下按名称搜索；仍找不到时，到其他磁盘或自定义的软件目录中搜索。",
    "   - 比较名称时忽略大小写、空格与连字符，例如「Foo Code」与 foo-code 视为同一个名称。目录名也可能是名称的一部分或厂商名，这时要有目录中的配置文件内容佐证。",
    "   - 以上方法都找不到时，停下并请我提供它的技能目录。不要用名称相近的其他程序或 Memmy 自身代替。",
    "2. 找到技能目录",
    "   - 要有依据，例如：官方文档或帮助命令中写明的技能位置；配置文件中指定的技能路径；该目录下已有的技能（含 SKILL.md 的子目录）。",
    `   - 只采用已经存在、且能确认由「${name}」读取的目录。推测出来的路径不能用。`,
    `   - 「${name}」不支持技能，或找不到技能目录时，停下并说明情况。不要改用其他方式，例如修改它的全局指令文件或添加 MCP 配置。`,
    "3. 运行添加命令",
    "",
    `   memmy-project agent connect --name "${name}" --skill-dir "<技能目录>"`,
    "",
    "   - 协作技能由命令写入。不要自己复制或编写技能文件。",
    "   - 命令失败时，按输出的原因核对第 1、2 步的结果后再运行。同一原因第二次失败时停下，把命令输出原样告诉我。",
    "",
    "## 禁止事项",
    `- 不读取、复制、转换或改写「${name}」的任务记录、聊天记录或数据库。`,
    "- 不新建目录、脚本或数据文件。",
    `- 不修改「${name}」的设置、全局指令或其他技能。`,
    "- 不安装 memmy-memory，不导入记忆。",
    "- 不为了让命令成功而改变上述做法。无法完成时停下说明，这属于正常结果，不是失败。",
    "",
    "## 结束时的回复",
    `- 添加成功：说明技能目录的位置、判断它属于「${name}」的依据，并告诉我：在「${name}」中新开一个对话，直接说「把这个任务加入 xx 项目」或「看看 xx 最近在做什么」即可。`,
    "- 中途停下：说明停在哪一步、已经找到什么、需要我提供什么。"
  ].join("\n");
}

/** The local Memmy project this onboarding task should belong to. A collab id is not a task project. */
export function resolveCollabConnectProjectId(
  project: { name: string; localProjectId: string | null },
  localProjects: readonly { id: string; name: string }[]
): string | null {
  const bound = project.localProjectId?.trim() ?? "";
  if (PROJECT_ID.test(bound)) return bound;
  const named = localProjects.find((item) => item.name === project.name);
  return named && PROJECT_ID.test(named.id) ? named.id : null;
}
