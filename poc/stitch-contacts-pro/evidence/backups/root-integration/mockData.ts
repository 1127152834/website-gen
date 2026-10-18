import type { Contact, ContactDraft, GroupId } from '../types.ts'

export const groups: ReadonlyArray<{ id: GroupId; label: string; color: string }> = [
  { id: 'work', label: '工作伙伴', color: '#789184' },
  { id: 'friends', label: '挚友圈', color: '#c27b77' },
  { id: 'family', label: '家人', color: '#d0a34c' },
  { id: 'partners', label: '合作伙伴', color: '#7389b4' },
]

export const copy = {
  appTitle: '知交 Pro', appSubtitle: '让每一段关系都被妥善珍藏', searchPlaceholder: '搜索姓名、公司、标签或地点…',
  addContact: '新建联系人', exportContacts: '导出通讯录', allContacts: '全部联系人', starredContacts: '星标联系人',
  dueContacts: '待联系', groups: '分组', allGroups: '全部分组', sortLabel: '排序', sortRecent: '最近添加', sortName: '姓名',
  sortFollowUp: '跟进日期', layoutGrid: '网格视图', layoutList: '列表视图', selectMode: '批量选择', exitSelect: '退出选择',
  selectVisible: '选择当前结果', clearSelection: '清空选择', edit: '编辑', delete: '删除', starSelected: '批量星标', cancel: '取消',
  confirmDelete: '确认删除', deleteTitle: '删除联系人？', deleteBody: '删除后仍可撤销最近一次操作。', undo: '撤销',
  saved: '已保存', created: '联系人已创建', updated: '联系人已更新', deleted: '联系人已删除', restored: '已撤销删除',
  exported: '导出文件已生成', contacted: '已记录本次联系', followUpSaved: '跟进日期已保存', noteAdded: '笔记已添加',
  storageReadError: '无法读取本机通讯录，数据未被覆盖。', storageWriteError: '无法保存到本机，请检查浏览器存储权限。',
  storageConflict: '检测到另一窗口中的更新，请刷新后再试。', storageInvalid: '本机通讯录格式异常，已停止写入以保护原数据。',
  formNameRequired: '请输入姓名', formNameTooLong: '姓名不能超过 60 个字符', formEmailInvalid: '邮箱格式不正确',
  formPhoneInvalid: '电话号码格式不正确', formFieldTooLong: '字段内容过长', formTagsTooLong: '标签最多 10 个，每个不超过 32 个字符',
  formSaveFailed: '保存失败，请稍后重试', noContacts: '还没有联系人', noResults: '没有符合条件的联系人',
  followUpNone: '未设置跟进', neverContacted: '尚未联系',
} as const

const day = 86_400_000
const startOfToday = new Date().setHours(0, 0, 0, 0)
const dateAt = (offset: number) => new Date(startOfToday + offset * day).toISOString().slice(0, 10)

const demo = (
  id: string, name: string, english: string, company: string, role: string, groupId: GroupId,
  color: Contact['color'], tags: string[], daysAgo: number, starred = false, followUp = '', location = '上海',
): Contact => ({
  id, name, english, company, role, email: `${id}@example.com`, phone: `202-555-01${id.slice(-2).padStart(2, '0')}`,
  groupId, tags, starred, color, avatar: '', location, notes: [], followUp, lastContacted: dateAt(-daysAgo - 3),
  createdAt: startOfToday - daysAgo * day + 12 * 60 * 60 * 1000,
})

// 演示数据：日期以打开页面当天为基准，不代表真实人物或真实联系方式。
export const seedContacts: Contact[] = [
  demo('demo01', '林沐', 'Mu Lin', '远山工作室', '品牌策略负责人', 'work', 'sage', ['品牌', '设计'], 0, true, dateAt(-1), '杭州'),
  demo('demo02', '陈放', 'Fang Chen', '栖木科技', '产品总监', 'partners', 'blue', ['产品', 'AI'], 1, true, dateAt(0), '深圳'),
  demo('demo03', '周宁', 'Nina Zhou', '回声文化', '策展人', 'friends', 'rose', ['艺术', '展览'], 2, true, '', '北京'),
  demo('demo04', '顾言', 'Yan Gu', '岸线资本', '投资经理', 'partners', 'gold', ['投资', '消费'], 4, true, dateAt(-2), '上海'),
  demo('demo05', '苏禾', 'He Su', '独立创作者', '摄影师', 'friends', 'peach', ['摄影', '旅行'], 6, false, '', '成都'),
  demo('demo06', '许嘉', 'Jia Xu', '澄明建筑', '建筑师', 'work', 'violet', ['建筑', '空间'], 8, false, '', '南京'),
  demo('demo07', '叶澜', 'Lan Ye', '白露咨询', '组织顾问', 'work', 'sage', ['组织', '管理'], 11, false, '', '苏州'),
  demo('demo08', '陆川', 'Chuan Lu', '晴野餐饮', '联合创始人', 'partners', 'gold', ['餐饮', '创业'], 15, false, '', '广州'),
  demo('demo09', '唐安', 'An Tang', '家人', '医生', 'family', 'blue', ['家人', '健康'], 18, false, '', '武汉'),
  demo('demo10', '温仪', 'Yi Wen', '木棉出版', '编辑', 'friends', 'rose', ['出版', '阅读'], 22, false, '', '北京'),
  demo('demo11', '简秋', 'Qiu Jian', '漫游计划', '内容主理人', 'work', 'peach', ['内容', '播客'], 28, false, '', '厦门'),
  demo('demo12', '沈屿', 'Yu Shen', '家人', '工程师', 'family', 'violet', ['家人', '科技'], 35, false, '', '西安'),
]

export const emptyDraft: ContactDraft = {
  name: '', english: '', company: '', role: '', email: '', phone: '', groupId: 'work', tags: [], starred: false,
  color: 'sage', avatar: '', location: '', followUp: '',
}
