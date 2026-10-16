/** 同一封已打开邮件只自动标记一次；列表刷新和手动“标为未读”不能再次触发。 */
export class MailOpenState {
  #openKey: string | null = null;

  shouldAutoMark(mailboxId: number, folder: string, uid: number, seen: boolean): boolean {
    const key = `${mailboxId}\u0000${folder}\u0000${uid}`;
    if (this.#openKey === key) return false;
    this.#openKey = key;
    return !seen;
  }

  leaveMessage(): void {
    this.#openKey = null;
  }
}

/** /mail 必须停留在邮箱选择页，否则窄屏“返回邮箱”会立即跳回第一封收件箱。 */
export function mailSelectionRedirect(mailboxId: number | undefined, mailboxIds: number[]): "/mail" | null {
  return mailboxId !== undefined && !mailboxIds.includes(mailboxId) ? "/mail" : null;
}

/** 收件箱未读数与左侧邮箱共用同一个数据源（同一条数据库查询），不会出现两边不一致；其他文件夹用各自的计数。 */
export function folderUnread(folder: { path: string; unread: number }, mailbox: { unreadCount: number } | null | undefined): number {
  return folder.path.toUpperCase() === "INBOX" && mailbox ? mailbox.unreadCount : folder.unread;
}
