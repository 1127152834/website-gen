import { z } from "zod";
export const addUserSchema = z.object({ username: z.string().trim().min(1, "请输入用户名"), password: z.string().min(8, "初始密码至少需要 8 位"), role: z.enum(["user", "admin"]) });
export const resetPasswordSchema = z.object({ password: z.string().min(8, "初始密码至少需要 8 位") });
