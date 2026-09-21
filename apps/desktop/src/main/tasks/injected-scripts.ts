/**
 * 注入脚本常量 —— 从 task-runner 唯一来源转发。
 *
 * 历史上有三份拷贝（task-runner 私有一份、本文件一份、已删除的 text-target-finder 一份），
 * 注释写着"共用一份"实际已漂移。本文件不再存第二份源码，只做转发，
 * 需要脚本片段的一律从 task-runner 引。
 */
export { VISIBLE_JS, PICK_SORT_FN, SCOPE_FN, ABSENT_FN, ENUM_DEEP_FN } from './task-runner'
