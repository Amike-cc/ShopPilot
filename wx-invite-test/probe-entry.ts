/**
 * 探针入口：把 shared 里的邀约构造器与平台档案打成一个 ESM 包，
 * 供 wx-invite-test 下的真机验证脚本 import（脚本是纯 node，不能直接吃 .ts）。
 * 打包命令见 wx-invite-test/README-probes.md。
 */
export { buildInviteTaskPayload, inviteTaskIssues, normalizeInviteTaskConfig } from '../packages/shared/src/invite-task'
export { inviteProfileFor, INVITE_PROFILES } from '../packages/shared/src/constants/invite'
// 步骤构造器与额度护栏常量也导出：验证/文档脚本要能打印"真实生成的步骤"与上限值
export { buildInviteSteps, buildAssistSteps, ASSIST_LOOP_MAX_ROUNDS, ASSIST_DEFAULT_MAX_INVITES, normalizeMaxInvites } from '../packages/shared/src/invite-steps'
