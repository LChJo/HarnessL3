> 历史资料：保留当时的方案和验证结论，不作为当前产品入口或待选方案。当前约束见[项目基准](../../PROJECT_BASELINE.md)。

# Skill Hub 与任务入口

2026-11-05，原型 v0.16；对应 [项目基准](baseline-history-v0.16.md) D10–D13。**Skill Hub** 按实际目录简述选择最小足够方法集合；当前 7 类/20 项方法，按文件夹→skill 名称→文件引用展开。grill-me 已并入单一 grilling 入口，Ask Matt 旧名称保留在来源说明及历史路由版本中。

## 入口与文件引用

```text
任务输入
  ├─ LikeC4 简述 + 上下文筛选提示 → 上下文目标 → 实际上下文包
  └─ Skill Hub + 实际技能轻目录 → 方法集合 → 版本化文件引用
                                              ↓
                                按需批量读取 SKILL.md / 附件
                                              ↓
                                  当前 agent 正常继续工作
```

选择由当前 agent 完成；CLI 不新增模型，不以关键词规则替模型选择，不运行技能工作流。普通终端的 start 只输出筛选材料，尚未实现通用 agent 启动器/投递协议。

技能是特殊文件引用：`id` 定位方法目录，`contentHash` 绑定该目录文件组，`files[].hash` 绑定实际字节。不是宿主必须安装的 `/skill` 命令，也不是选择后自动运行的工具。入口仅提供简述和关联方法，交接返回引用清单；按需要读取已选方法和附件，避免一次塞入所有文件。LikeC4 仍是项目上下文主模型，技能不混入五类或 C4。

## 文件目录与自动更新

默认来源是 [skills/](../../../skills/README.md)，布局为 `skills/<category>/<name>/SKILL.md`。当前 7 类为 discovery、planning、architecture、development、quality、knowledge、meta，共 20 项。方法名保留，当前目录 ID 随分类迁移；重复包装 grill-me 删除，通用访谈统一使用 discovery/grilling。基于本地参考提交 `2ab958093e83e0ec752e6c1c5932da465bf23e0c` 适配，保留 [MIT](../../../skills/LICENSE)；[初次适配](design/skill-hub-file-audit.md) 与 [当前重分类](design/skill-taxonomy.md) 分别记录当时状态。不回写参考仓库，不安装到用户全局技能目录。

配置其它路径时，设置服务环境变量 `HARNESS_SKILLS_ROOT`，或在忽略的 `.harness-local/skills.json` 中写入：

```json
{"root":"<技能目录的绝对路径或相对项目根的路径>"}
```

路径配置在服务启动时读取。目录内的增删改无需重启或编译：服务使用递归文件监听、120ms 防抖，并每 5 秒重新核对，恢复遗漏事件/临时缺失目录；Web 通过 SSE 更新实际目录状态。数字是当前实现参数，不是性能 SLA。

Web 的 **刷新技能目录** 按钮与 `skills --refresh` 可立即核对，显示实际路径、最近检查和诊断。无效 YAML/重名等会显式报错，当前候选清空，不将最近有效目录伪装成当前。修复文件后自动恢复。刷新不会改写正文、自动增加技能或改写已选方案。

`name` 唯一、`description` 非空；组/目录/名称使用字母数字与 `._-`。YAML 1.2 元数据与指纹来自同一份捕获字节，避免混合旧简述和新正文。单文件最多 2 MiB、单技能 200 文件、深度 12；不通过符号链接越界读取。`related` 是可选的、相对当前 SKILL.md 的关联入口路径，例如：

```yaml
related:
  - ../tdd/SKILL.md
  - ../../discovery/grilling/SKILL.md
```

Hub 按实际文件解析为目录 ID；不存在的关联会生成诊断。关联只帮助筛选，不自动加入选择、读取或执行。修改目录/删除技能后应核对缺失提示。普通方法文件保留有用流程/附件，已去除强制提交、固定会话工具和必须安装 slash 命令的假设；共享维护说明不是历史执行依赖。

## CLI

先启动本机服务，再由当前 agent 读取入口：

```powershell
node scripts/harness.mjs start --title '排查下载取消后仍继续传输'
```

输出任务/worktree、模型与来源版本、实际技能源目录、顶层简述、当前方法轻目录和联合筛选提示。未选择的完整正文和附件不进入提示。可用 `--json` 取得结构化入口。

当前 agent 将一次选择保存成 UTF-8 JSON：

```json
{
  "modelRevision": "<入口模型版本>",
  "catalogRevision": "<入口技能目录版本>",
  "expand": ["mgrp.execution", "mgrp.network"],
  "read": ["mgrp.execution.task", "mgrp.network"],
  "skills": [
    {"id":"quality/diagnosing-bugs","reason":"需要可复现诊断定位取消行为"},
    {"id":"quality/tdd","reason":"后续修复需要行为回归"}
  ]
}
```

这是格式示例，不是固定自动选择规则。提交并按需取文件：

```powershell
node scripts/harness.mjs select <task-id> --file <selection.json>
node scripts/harness.mjs handoff <task-id>
node scripts/harness.mjs read <task-id> --skill quality/tdd --path SKILL.md
```

`select` 的普通文本和 JSON 都先返回引用，不把归档全文隐含塞入结果。交接给出每个文件的 `harness-skill://<task>/<skill>/<path>#<sha256>` 引用、路径、指纹、字节数和编码；该 URI 是归档标识，读取使用 CLI 的 skill/path 或批量文件列表，不是浏览器文件链接。直接文件工具继续可用，读取当前源文件前应核对指纹，不以当前版本冒充历史。

批量读取多项方法或附件，将需要的引用写成 `files.json`：

```json
{"files":[
  {"skillId":"quality/diagnosing-bugs","path":"SKILL.md"},
  {"skillId":"quality/tdd","path":"SKILL.md"},
  {"skillId":"quality/tdd","path":"tests.md","hash":"<可选的预期指纹>"}
]}
```

```powershell
node scripts/harness.mjs read <task-id> --file files.json --batch <已选择后的批次id>
```

读取只允许本次已确认选择里的文件，返回选择时归档的实际字节、编码和 SHA-256。未选依赖不能借相对路径越界读取；如任务范围改变，应新建选择。归档损坏、未知路径、错误指纹或选择前批次显式失败，不回退到当前文件。

| 命令 | 用途 |
| --- | --- |
| `start --title ... [--session ...]` | 创建任务并输出入口；session 是调用方声明 |
| `prompt <id> [--refresh]` | 未选择时按当前目录重新准备提示；过期版本需重新筛选 |
| `select <id> --file ...` | 一次提交 expand/read 和含理由的技能集合 |
| `handoff <id> [--batch ...]` | 所选上下文及版本化技能引用，可冻结批次 |
| `read <id> --file ...` | 按需批量返回所选归档文件，不执行、不续期 |
| `read <id> --skill ... [--path ...]` | 读取单个归档文件，默认 SKILL.md |
| `skills [--refresh]` | 当前目录、引用元数据、诊断和版本 |

命令也可 `npm run harness -- ...`；后续局部上下文及历史仍使用 `npm run context -- query/show/history`。`skills:[]` 明确无需额外方法，与缺记录/未知有别；一任务只提交一次集合，重复/并发选择不能覆盖方案。

## API 与状态边界

| API | 用途 |
| --- | --- |
| `GET /api/skills/catalog` | 当前目录状态；有 error 时无当前候选，供 UI 展示诊断 |
| `POST /api/skills/refresh` | 手动立即刷新，返回相同状态字段 |
| `GET /api/stream` 的 skills 事件 | 目录增删改/诊断恢复；连接时提供当前状态 |
| `POST /api/harness/tasks` | 创建联合入口 |
| `POST /api/harness/tasks/:id/prompt` | 尚未选择时更新实际目录，支持 refreshCatalog |
| `POST /api/harness/tasks/:id/select` | 返回轻量 task/result/selection/handoff/references |
| `GET /api/harness/tasks/:id/handoff?batch=...` | 固定批次的上下文及文件引用 |
| `POST /api/harness/tasks/:id/read` | `{files:[{skillId,path,hash?}],batchId?}`，批量归档字节 |

选择绑定任务/worktree、模型和技能目录版本。技能在入口后变化会拒绝旧选择，不先混入上下文；重新取 prompt 后由 agent 重新筛选。模型变化/60 天超期拒绝新选择。部分上下文失败保留为 partial，中断未确认是 unknown，不能生成准备完成方案。

选择时保存完整所选文件供历史，浏览器档案详情可以查看这些字节；它们不是新的可编辑权威。查看历史、取 handoff/read 不延长 60 天窗口，也不产生“技能已执行”的记录。当前只知道选择已记录和文件返回；未采集的理解、执行和其他工具操作仍未知。

## 连线脑图与历史

上方五类原理保留，下方 **输入→Skill Hub→文件夹→skill 名称→文件引用→技能方案** 同属一个无限画布。默认只显示 Hub 和方案，点击 Hub 显示文件夹，点击文件夹显示所属 skill，再点 skill 才显示实际文件；详情按钮独立。文件夹来自实际 group，已选时只组织本次集合并汇总数量，未选时浏览全部目录，不冒充已选择连线。收起父层隐藏全部后代，任务/SSE/目录变化不自动展开；各层展开保留点击位置，可平移缩放，桌面/手机共享定位。

分组优先使用保存的 group；旧字段缺失可从当时类别/方法 ID 定位，否则显示“未记录文件夹”，不借当前目录重分类。展开不增加上下文读取或技能执行记录。

已保存方案始终使用当时目录/文件；更新目录不会替换选中任务或历史。按批次恢复时，选择前未知，选择后显示当时集合和文件，后续事件不污染打开的历史；交接固定当前打开批次。旧 Ask Matt 路由版本保留原值以供追溯，界面名称统一为 Skill Hub。

当前验证记录见 [项目基准第 27 节](baseline-history-v0.16.md)。这里只实现本机读取/展示切片；完整 agent 启动投递、多项目生命周期、安装分发、持久索引和性能预算仍待后续。
