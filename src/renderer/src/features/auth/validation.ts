import { z } from "zod";

export const loginSchema = z.object({ username: z.string().trim().min(1, "请输入用户名"), password: z.string().min(1, "请输入密码") });
export const changePasswordSchema = z.object({ oldPassword: z.string().min(1, "请输入当前密码"), newPassword: z.string().min(8, "新密码至少需要 8 位"), confirm: z.string().min(1, "请再次输入新密码") }).superRefine((value, context) => {
  if (value.newPassword !== value.confirm) context.addIssue({ code: "custom", path: ["confirm"], message: "两次输入的新密码不一致" });
  if (value.newPassword === value.oldPassword) context.addIssue({ code: "custom", path: ["newPassword"], message: "新密码不能和当前密码相同" });
});
