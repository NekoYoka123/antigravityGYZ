/**
 * 应用配置管理文件
 * 使用 Zod 进行环境变量验证，提供配置缓存机制
 */
import { z } from 'zod';

/**
 * 应用配置类型定义
 */
export type AppConfig = {
  jwtSecret: string; // JWT 签名密钥
  port: number; // 服务器监听端口
  redisUrl: string; // Redis 连接 URL
  discord: { // Discord OAuth 配置
    clientId: string; // Discord 客户端 ID
    clientSecret: string; // Discord 客户端密钥
    redirectUri: string; // Discord 重定向 URI
  };
  admin: { // 管理员账户配置
    username?: string; // 管理员用户名
    password?: string; // 管理员密码
  };
};

// 配置缓存，避免重复读取环境变量
let cached: AppConfig | null = null;

/**
 * 获取应用配置
 * 从环境变量读取配置，使用 Zod 验证，缓存结果
 * @returns 应用配置对象
 */
export function getConfig(): AppConfig {
  // 如果已有缓存，直接返回
  if (cached) return cached;

  // 使用 Zod 验证环境变量
  const Env = z.object({
    JWT_SECRET: z.string().optional(), // JWT 密钥
    PORT: z.string().optional(), // 端口
    REDIS_URL: z.string().optional(), // Redis 连接 URL
    DISCORD_CLIENT_ID: z.string().optional(), // Discord 客户端 ID
    DISCORD_CLIENT_SECRET: z.string().optional(), // Discord 客户端密钥
    DISCORD_REDIRECT_URI: z.string().optional(), // Discord 重定向 URI
    ADMIN_USERNAME: z.string().optional(), // 管理员用户名
    ADMIN_PASSWORD: z.string().optional(), // 管理员密码
  }).parse(process.env as any);

  // 构建 Discord 配置
  const discord = {
    clientId: Env.DISCORD_CLIENT_ID ?? '', // 使用空字符串作为默认值
    clientSecret: Env.DISCORD_CLIENT_SECRET ?? '',
    redirectUri: Env.DISCORD_REDIRECT_URI ?? '',
  };

  // 构建管理员配置
  const admin = {
    username: Env.ADMIN_USERNAME,
    password: Env.ADMIN_PASSWORD,
  };

  // 设置默认值
  const jwtSecret = Env.JWT_SECRET ?? 'dev-secret'; // 默认 JWT 密钥
  const port = Env.PORT ? parseInt(String(Env.PORT), 10) : 3000; // 默认端口 3000
  const redisUrl = Env.REDIS_URL ?? 'redis://localhost:6379'; // 默认 Redis URL

  // 缓存配置
  cached = { jwtSecret, port, redisUrl, discord, admin };
  return cached;
}
