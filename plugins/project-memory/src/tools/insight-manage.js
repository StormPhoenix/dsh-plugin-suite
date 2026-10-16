import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertIndexRoot, memoryRootFor, resolveSafeIndexRoot } from '../util/fs.js'
import { ProjectMemoryStore } from '../store.js'
import { cfgInsight, defaultGlobalFile, GlobalStore } from '../insight-store.js'
import { actInsight, listInsights } from '../commands/insight-actions.js'

const ACTIONS = ['list', 'archive', 'restore', 'delete']
const SCOPES = ['task', 'project', 'global']

/**
 * 模型端 insight 管理工具：补齐「能写不能删」的不对称。
 * 模型可以把错误经验写入记忆（remember/自动固化），此前却没有任何删除/归档手段，
 * 只能靠用户在面板里手动清理。本工具让模型能够整理（尤其是收回）自己写入的条目。
 *
 * 边界：本工具仅整理记忆条目本身，不改变当前会话的运行时权限与策略——
 * 不得用它绕过任何运行时限制。
 */
export function insightManageTool(config) {
  return defineTool({
    name: 'insight_manage',
    description:
      'Manage saved insight entries (list / archive / restore / delete) across task, project and global scopes. '
      + 'Use to retire wrong, stale or overly-broad experience entries you previously saved — for example a '
      + 'lesson that generalized a one-off runtime situation into a permanent rule. '
      + 'Governance only: it never changes the current sandbox mode or approval policy.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: 'list = 条目清单；archive = 软删（退出召回/注入，可 restore）；restore = 恢复归档；delete = 物理删除。',
      },
      scope: {
        type: 'string',
        enum: SCOPES,
        description: '条目作用域。global 的条目跨项目召回，检查时要显式带上。',
      },
      id: {
        type: 'string',
        description: 'insight id（ins_…），archive/restore/delete 必填；list 可省略。',
      },
      include_archived: {
        type: 'boolean',
        description: 'list 时是否包含已归档条目（默认否）。',
      },
      root: {
        type: 'string',
        description: '项目根目录，默认当前工作目录。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const root = resolveSafeIndexRoot(exec, args.root, config)
      assertIndexRoot(root, args.root || root)
      const memoryDir = memoryRootFor(root, config.memoryDir)
      const store = new ProjectMemoryStore(memoryDir).load()
      const gs = new GlobalStore(cfgInsight(config).globalFile || defaultGlobalFile()).load()

      if (args.action === 'list') {
        const scope = SCOPES.includes(args.scope) ? args.scope : undefined
        let items
        if (scope) {
          items = listInsights(store, gs, scope).items ?? []
        } else {
          items = [
            ...(listInsights(store, gs, 'task').items ?? []),
            ...(listInsights(store, gs, 'project').items ?? []),
            ...(listInsights(store, gs, 'global').items ?? []),
          ]
        }
        const visible = items.filter(it => args.include_archived || !it.archived)
        const lines = visible.map(it =>
          `${it.id}  [${it.scope}/${it.kind}${it.archived ? '/archived' : ''}${it.draft ? '/draft' : ''}]`
          + `  ${it.title || it.pattern || it.topic || '(untitled)'}`
          + `  hits=${it.hitCount ?? 0}`)
        return lines.length
          ? `insight 条目 ${visible.length} 条：\n${lines.join('\n')}\n\n用 insight_manage archive/restore/delete <scope> <id> 管理。`
          : '没有匹配的 insight 条目。'
      }

      if (!SCOPES.includes(args.scope)) return `非法 scope: ${args.scope}（需要 task|project|global）`
      if (!args.id) return 'archive/restore/delete 需要 id'
      const res = actInsight({
        store,
        gs,
        action: args.action,
        scope: args.scope,
        id: args.id,
        taskId: undefined,
        cfg: cfgInsight(config),
      })
      store.commit(() => 0)
      gs.commit()
      return res.ok ? res.text : `[insight_manage] ${res.text}`
    },
  })
}
