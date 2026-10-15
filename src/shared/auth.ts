/** Web 版当前登录用户；业务数据仍全部留在各自工作区。 */
export interface AuthUser {
  id: number;
  username: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
}

/** 管理员能看到的只有账号元数据，不包含任何用户的业务数据。 */
export interface AdminUser extends AuthUser {
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}
