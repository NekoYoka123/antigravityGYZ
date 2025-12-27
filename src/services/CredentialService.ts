/**
 * 凭证服务
 * 负责 Google 凭证的上传、验证、刷新和管理
 */
import { PrismaClient, CredentialStatus } from '@prisma/client';
import { request } from 'undici';
import { z } from 'zod';
import { CredentialPoolManager } from './CredentialPoolManager';
import { getUserAgent } from '../utils/system';
import crypto from 'crypto';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();
const poolManager = new CredentialPoolManager();

// 反代验证配置
const PROXY_VERIFY_PORT = process.env.PORT || 3000;

// 缓存系统管理员 Key（避免每次查询数据库）
let cachedAdminKey: string | null = null;

/**
 * 获取或创建系统管理员 API Key 用于反代验证
 * 优先使用已有的 ADMIN 类型 Key，没有则自动创建
 * @returns 系统管理员 API Key
 */
async function getOrCreateSystemAdminKey(): Promise<string> {
  // 如果已缓存，直接返回
  if (cachedAdminKey) return cachedAdminKey;

  // 1. 查找已有的 ADMIN 类型 Key
  const existingAdminKey = await prisma.apiKey.findFirst({
    where: {
      type: 'ADMIN',
      is_active: true
    },
    select: { key: true }
  });

  if (existingAdminKey) {
    cachedAdminKey = existingAdminKey.key;
    console.log('[CredentialService] 使用已有管理员 Key 进行验证');
    return cachedAdminKey;
  }

  // 2. 没有 ADMIN Key，查找管理员用户并创建一个
  const adminUser = await prisma.user.findFirst({
    where: { role: 'ADMIN' }
  });

  if (!adminUser) {
    console.warn('[CredentialService] 没有找到管理员用户，反代验证可能失败');
    return 'no-admin-key-available';
  }

  // 3. 为管理员创建一个系统验证专用的 Key
  const newKey = 'sk-sys-' + crypto.randomBytes(24).toString('hex');

  await prisma.apiKey.create({
    data: {
      key: newKey,
      name: '系统验证专用 (自动创建)',
      type: 'ADMIN',
      is_active: true,
      user_id: adminUser.id
    }
  });

  cachedAdminKey = newKey;
  console.log('[CredentialService] 自动创建系统管理员 Key 用于验证');
  return cachedAdminKey;
}

/**
 * 凭证输入验证模式
 * 使用 Zod 库进行类型安全验证
 */
const CredentialInputSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  project_id: z.string().optional(),
});

/**
 * 凭证服务类
 * 负责 Google 凭证的上传、验证、刷新和管理
 */
export class CredentialService {
  /**
   * 上传并验证 Google OAuth2 凭证
   * 流程：解析 -> 获取 Token -> 临时入库 -> 加入池 -> Cloud Code 验证 -> 成功保留/失败删除
   * @param userId 用户 ID
   * @param jsonContent 凭证 JSON 内容
   * @param requireV3 是否要求支持 Gemini 3.0
   * @returns 验证成功的凭证信息
   */
  async uploadAndVerify(userId: number, jsonContent: string, requireV3: boolean = false) {
    // 1. Parse and Validate JSON structure
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonContent);
    } catch (e) {
      throw new Error('Invalid JSON format');
    }

    // Support both flat and nested (web/installed) formats (normalized to avoid trailing spaces)
    const clientId = (parsedJson.client_id || parsedJson.web?.client_id || parsedJson.installed?.client_id || '').trim();
    const clientSecret = (parsedJson.client_secret || parsedJson.web?.client_secret || parsedJson.installed?.client_secret || '').trim();
    const refreshToken = (parsedJson.refresh_token || '').trim();
    const projectId: string = (parsedJson.project_id || '').trim();

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Invalid Credential JSON: Missing client_id, client_secret, or refresh_token');
    }

    // 2. Duplication guard: refresh_token 不允许重复上传（无需解析邮箱即可拦截）
    const existingByToken = await prisma.googleCredential.findFirst({
      where: { refresh_token: refreshToken },
      select: { id: true }
    });
    if (existingByToken) {
      throw new Error(`❌ 重复上传\n\n该 refresh_token 已存在（ID: ${existingByToken.id}）`);
    }

    // 3. Exchange Refresh Token for Access Token
    const accessToken = await this.refreshAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) {
      throw new Error('❌ Token 刷新失败\n\n凭证可能已过期或无效');
    }

    // 2.1 Fetch Google account email and enforce uniqueness
    const googleEmail = await this.fetchGoogleEmail(accessToken);
    if (!googleEmail) {
      throw new Error('❌ 无法获取 Google 账号邮箱\n\n请确认凭证是否有效');
    }

    const existingByEmail = await prisma.googleCredential.findFirst({
      where: {
        OR: [
          { google_email: googleEmail },
          { refresh_token: refreshToken }
        ]
      }
    });

    if (existingByEmail) {
      throw new Error('❌ 重复上传\n\n当前 Google 账号或 refresh_token 已经上传过凭证');
    }

    // 3. 先将凭证临时保存到数据库（VALIDATING 状态）
    let tempCredential: any = null;
    try {
      tempCredential = await prisma.googleCredential.create({
        data: {
          owner_id: userId,
          google_email: googleEmail,
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          project_id: projectId,
          access_token: accessToken,
          is_active: false, // 暂时不激活
          supports_v3: false,
          status: CredentialStatus.VALIDATING,
        },
      });
      console.log(`[CredentialService] 凭证临时入库: ID=${tempCredential.id}`);
    } catch (dbError: any) {
      console.error('[CredentialService] 临时入库失败:', dbError);
      throw new Error('❌ 数据库错误\n\n无法保存凭证');
    }

    // 4. 将凭证添加到上传池
    let uploadPoolAdded = false;
    try {
      await poolManager.addUploadCredential(tempCredential.id);
      uploadPoolAdded = true;
      console.log(`[CredentialService] 凭证加入上传池: ID=${tempCredential.id}`);
    } catch (poolError: any) {
      // 加入池失败，删除数据库记录
      await prisma.googleCredential.delete({ where: { id: tempCredential.id } }).catch(() => { });
      console.error('[CredentialService] 加入池失败:', poolError);
      throw new Error('❌ 系统错误\n\n无法添加到上传池');
    }

    // 5. 通过 Cloud Code 验证凭证
    let verifySuccess = false;
    let verifyError: string | null = null;
    let supportsV3 = false;

    try {
      // 5.1 基础验证 (gemini-2.5-flash)
      try {
        const baseOk = await this.verifyCloudCodeAccess(accessToken, projectId, 'gemini-2.5-flash', false);
        if (baseOk) {
          verifySuccess = true;
          console.log(`[CredentialService] 2.5 验证通过: ID=${tempCredential.id}`);
        } else {
          verifyError = '❌ 凭证验证失败';
        }
      } catch (baseError: any) {
        verifyError = `❌ 凭证验证失败\n\n${baseError.message || 'unknown error'}`;
      }

      if (verifySuccess) {
        // 5.2 检测 Gemini 3.0 支持
        try {
          const v3Ok = await this.verifyCloudCodeAccess(accessToken, projectId, 'gemini-3-flash-preview', false);
          if (v3Ok) {
            supportsV3 = true;
            console.log(`[CredentialService] Gemini 3.0 支持: ID=${tempCredential.id}`);
          }
        } catch (v3Error: any) {
          console.warn(`[CredentialService] Gemini 3.0 检测失败: ${v3Error.message || v3Error}`);
        }

        // 如果要求 V3 但不支持
        if (requireV3 && !supportsV3) {
          verifySuccess = false;
          verifyError = '❌ Gemini 3.0 验证失败或无法确认\n\n此凭证未确认支持 Gemini 3.0 模型';
        }
      }
    } catch (verifyErrorAny: any) {
      verifyError = `❌ 验证异常\n\n${verifyErrorAny.message || verifyErrorAny}`;
    }

    // 6. 根据验证结果处理
    if (!verifySuccess) {
      // 验证失败：从池中移除并删除数据库记录
      try {
        if (uploadPoolAdded) {
          await poolManager.removeUploadCredential(tempCredential.id);
        }
      } catch { }

      await prisma.googleCredential.delete({ where: { id: tempCredential.id } }).catch(() => { });
      console.log(`[CredentialService] 验证失败，已删除凭证: ID=${tempCredential.id}`);

      throw new Error(verifyError || '❌ 凭证验证失败');
    }

    // 7. 验证成功：更新状态并升级用户
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        // 更新凭证状态
        const credential = await tx.googleCredential.update({
          where: { id: tempCredential.id },
          data: {
            is_active: true,
            supports_v3: supportsV3,
            status: CredentialStatus.ACTIVE,
            last_validated_at: new Date(),
          },
        });

        // 升级用户
        await tx.user.update({
          where: { id: userId },
          data: { level: 1 },
        });

        return credential;
      });

      if (uploadPoolAdded) {
        try { await poolManager.removeUploadCredential(tempCredential.id); } catch { }
      }
      await poolManager.addCredential(result.id, supportsV3);

      console.log(`[CredentialService] 验证成功: User ${userId}, Credential ID: ${result.id}, V3: ${supportsV3}`);
      return result;

    } catch (error: any) {
      if (uploadPoolAdded && tempCredential?.id) {
        try { await poolManager.removeUploadCredential(tempCredential.id); } catch { }
      }
      console.error(`[CredentialService] 更新状态失败:`, error);
      throw new Error('❌ 系统错误\n\n凭证验证成功但保存失败');
    }
  }


  /**
   * 使用 undici 将 Refresh Token 交换为短期 Access Token
   * 将令牌缓存到 Redis 中以提高性能
   * @param clientId 客户端 ID
   * @param clientSecret 客户端密钥
   * @param refreshToken 刷新令牌
   * @returns 访问令牌，或 null（如果刷新失败）
   */
  private async refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string | null> {
    const cacheKey = `ACCESS_TOKEN:${clientId.slice(0, 10)}:${refreshToken.slice(-10)}`; // Simple hash key

    // 1. Try Cache - 使用共享的 Redis 连接
    const cached = await redis.get(cacheKey);
    if (cached) {
      return cached;
    }

    const oauthUrl = process.env.GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com/token';
    try {
      const { statusCode, body } = await request(oauthUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (statusCode !== 200) {
        const errorText = await body.text();
        console.error(`[CredentialService] Token Refresh Failed (${statusCode}):`, errorText);
        return null;
      }

      const data = await body.json() as any;
      const accessToken = data.access_token;

      if (accessToken) {
        // Cache for 55 minutes (expires_in is usually 3600s)
        await redis.set(cacheKey, accessToken, 'EX', 3300);
      }

      return accessToken || null;

    } catch (error) {
      console.error('[CredentialService] Token Refresh Network Error:', error);
      return null;
    }
  }

  /**
   * 通过向内部 Cloud Code API 发送实际请求来验证凭证
   * 使用 gemini-cli-core 中找到的正确包装结构
   * @param accessToken 访问令牌
   * @param projectId 项目 ID（可选）
   * @param modelName 模型名称
   * @param allow429 是否允许 429 错误
   * @returns 验证是否成功
   */
  public async verifyCloudCodeAccess(accessToken: string, projectId?: string, modelName: string = 'gemini-2.5-flash', allow429: boolean = true): Promise<boolean> {
    const baseUrl = process.env.GOOGLE_CLOUD_CODE_URL || 'https://cloudcode-pa.googleapis.com';
    const targetUrl = `${baseUrl}/v1internal:generateContent`;

    // Use a more complete payload to avoid 400 errors from strict models
    const payload: any = {
      model: modelName,
      user_prompt_id: 'validation-check',
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hi" }]
          }
        ],
        generationConfig: {
          maxOutputTokens: 10,
          temperature: 0.1
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      }
    };
    if (projectId && projectId.trim() !== '') {
      payload.project = projectId;
    }

    try {
      const { statusCode, body } = await request(targetUrl, {
        method: 'POST',
        headers: {
          'User-Agent': getUserAgent(),
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        headersTimeout: 30000,
        bodyTimeout: 30000,
      });

      if (statusCode === 200) {
        try {
          const data = await body.json() as any;
          // Relaxed check: as long as it's 200 OK and valid JSON, we consider it a pass.
          // Safety blocks or empty content are still "valid access".
          if (data.candidates || data.promptFeedback) return true;

          console.warn(`[CredentialService] Validation 200 OK but weird structure: ${JSON.stringify(data)}`);
          return true;
        } catch (e) {
          console.error('[CredentialService] Failed to parse validation response:', e);
          return false;
        }
      }

      const errorText = await body.text();
      console.error(`[CredentialService] Validation Failed for ${modelName} (${statusCode}):`, errorText);

      // Special handling for 429: allow upload flow to proceed when allow429=true
      if (statusCode === 429) {
        return allow429;
      }

      // Other errors (e.g., 403) are treated as failures
      const err = new Error(`API Error ${statusCode}: ${errorText.substring(0, 200)}`);
      (err as any).statusCode = statusCode;
      throw err;

    } catch (error: any) {
      console.error(`[CredentialService] Network/API Error for ${modelName}:`, error.message);
      throw error; // Propagate up
    }
  }

  /**
   * 通过反代服务验证凭证。
   * 默认使用管理员 key；传 useCredentialToken=true 时改用凭证自身 token 直连代理。
   * allow429 控制是否在 429 时放行（默认严格不放行）。
   */
  public async verifyViaProxy(
    accessToken: string,
    projectId?: string,
    modelName: string = 'gemini-2.5-flash',
    options?: { useCredentialToken?: boolean; allow429?: boolean }
  ): Promise<{ success: boolean; response?: string; error?: string }> {
    const proxyUrl = `http://localhost:${PROXY_VERIFY_PORT}/v1/chat/completions`;
    const useCredentialToken = options?.useCredentialToken ?? false;
    const allow429 = options?.allow429 ?? false;

    try {
      console.log(`[CredentialService] 使用 Cloud Code 直连验证 (model: ${modelName}, token=${useCredentialToken ? 'credential' : 'admin'})`);

      // 选择认证 Header
      const bearerToken = useCredentialToken ? accessToken : await getOrCreateSystemAdminKey();

      // 处理 429/5xx 重试
      const doOnce = async () => {
        return await request(proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearerToken}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 10
          }),
          headersTimeout: 60000,
          bodyTimeout: 60000
        });
      };
      let attempt = 0;
      let statusCode: number = 0;
      let body: any;
      while (attempt < 3) {
        const res = await doOnce();
        statusCode = res.statusCode;
        body = res.body;
        if (statusCode === 429 || statusCode === 503 || statusCode === 502 || statusCode === 500) {
          const backoff = [500, 1500, 3000][attempt];
          console.warn(`[CredentialService] Cloud Code 重试 ${statusCode}, 次数 ${attempt + 1}/3, 等待 ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          attempt++;
          continue;
        }
        break;
      }

      const responseText = await body.text();

      if (statusCode === 200) {
        try {
          const data = JSON.parse(responseText);
          // 如果代理返回了 error 字段，视为失败（例如上游 403/权限问题被代理吞掉）
          if (data.error) {
            const msg = typeof data.error === 'string'
              ? data.error
              : (data.error.message || JSON.stringify(data.error));
            return { success: false, error: `❌ 验证失败 (上游错误)\n\n${msg}` };
          }
          const content = data.choices?.[0]?.message?.content || '';
          // 403/权限提示有时藏在 200 的文本里，出现关键词时强制判定为失败
          const dangerText = content.toLowerCase();
          const denyHints = ['permission_denied', 'permission denied', 'permission', '403', 'forbidden', 'insufficient', 'not enabled', 'access denied', 'scope', 'permission is required'];
          if (denyHints.some(h => dangerText.includes(h))) {
            return { success: false, error: `❌ 验证失败：疑似权限不足\n\n${content.substring(0, 120)}` };
          }
          if (!content) {
            return { success: false, error: '❌ 验证失败：无有效响应内容，可能权限不足或返回空数据' };
          }
          console.log(`[CredentialService] 验证响应: ${content.substring(0, 50)}`);
          return {
            success: true,
            response: `✅ 代理验证返回 "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`
          };
        } catch {
          // 200 但无法解析，保守判为失败，避免 403/错误被误判为成功
          return { success: false, error: '❌ 验证失败：返回内容无法解析，可能为权限错误' };
        }
      } else {
        // 429/5xx/其他错误：Cloud Code 非 200；allow429=true 时放行 429
        if (statusCode === 429 && allow429) {
          return { success: true, response: '✅ 已放行 429（Cloud Code 负载过高）' };
        }

        let formattedError = `❌ 验证失败 (HTTP ${statusCode})`;
        try {
          const errData = JSON.parse(responseText);
          if (errData.error?.message) {
            formattedError += `

错误详情:
${errData.error.message}`;
          } else if (errData.error) {
            formattedError += `

错误详情:
${JSON.stringify(errData.error, null, 2)}`;
          }
        } catch {
          if (responseText.length > 0 && responseText.length < 500) {
            formattedError += `

错误详情:
${responseText}`;
          }
        }
        console.error(`[CredentialService] 验证失败 (${statusCode}):`, responseText.substring(0, 200));
        return { success: false, error: formattedError };
      }
    } catch (error: any) {
      const formattedError = `❌ Cloud Code 请求失败

错误详情:
${error.message}`;
      console.error('[CredentialService] Cloud Code 请求异常:', error.message);
      return { success: false, error: formattedError };
    }
  }

  /**
   * 使用访问令牌通过 userinfo 端点获取 Google 账户邮箱
   * 如果请求失败或缺少邮箱，则返回 null
   * @param accessToken 访问令牌
   * @returns Google 账户邮箱，或 null（如果获取失败）
   */
  private async fetchGoogleEmail(accessToken: string): Promise<string | null> {
    const url = 'https://www.googleapis.com/oauth2/v2/userinfo';

    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: {
          'User-Agent': getUserAgent(),
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        headersTimeout: 30000,
        bodyTimeout: 30000
      });


      if (statusCode !== 200) {
        const text = await body.text();
        console.error(`[CredentialService] Fetch Google userinfo failed (${statusCode}):`, text);
        return null;
      }

      try {
        const data = await body.json() as any;
        const email = data?.email;
        if (typeof email === 'string' && email.length > 0) {
          return email;
        }
        console.warn('[CredentialService] Google userinfo has no email field.');
        return null;
      } catch (e) {
        console.error('[CredentialService] Failed to parse Google userinfo response:', e);
        return null;
      }
    } catch (error: any) {
      console.error('[CredentialService] Google userinfo request error:', error.message);
      return null;
    }
  }

  /**
   * 手动检查存储的凭证是否支持 Gemini 3.0
   * 返回包含详细结果的对象
   * 使用凭证自身 token 通过 Cloud Code 验证，不放行 429/5xx
   * @param credential 凭证信息
   * @returns 包含支持情况和详细信息的对象
   */
  async checkV3Support(credential: any): Promise<{ supported: boolean; error?: string; response?: string }> {
    try {
      // 1. Refresh Token
      const accessToken = await this.refreshAccessToken(credential.client_id, credential.client_secret, credential.refresh_token);
      if (!accessToken) throw new Error('❌ Token 刷新失败\n\n凭证可能已过期或无效');

      // 2. 使用 Cloud Code 验证 3.0 (严格：429/5xx 失败)
      let supportsV3 = false;
      let proxyResponse: string | undefined;

      try {
        const ok = await this.verifyCloudCodeAccess(accessToken, credential.project_id, 'gemini-3-flash-preview', false);
        if (ok) {
          supportsV3 = true;
          proxyResponse = '✅ Cloud Code 验证通过';
          console.log(`[CredentialService] Cloud Code 验证 Gemini 3.0 通过`);
        }
      } catch (e: any) {
        if (credential.id && credential.supports_v3) {
          await prisma.googleCredential.update({
            where: { id: credential.id },
            data: { supports_v3: false }
          }).catch(() => { });
          try { await redis.lrem('GLOBAL_CREDENTIAL_POOL_V3', 0, String(credential.id)); } catch { }
          console.warn(`[CredentialService] 凭证 ${credential.id} 取消 V3 资格（验证失败）`);
        }
        return { supported: false, error: e.message };
      }

      if (!supportsV3) {
        if (credential.id && credential.supports_v3) {
          await prisma.googleCredential.update({
            where: { id: credential.id },
            data: { supports_v3: false }
          }).catch(() => { });
          try { await redis.lrem('GLOBAL_CREDENTIAL_POOL_V3', 0, String(credential.id)); } catch { }
          console.warn(`[CredentialService] 凭证 ${credential.id} 取消 V3 资格（验证失败）`);
        }
        return { supported: false, error: '❌ Gemini 3.0 验证失败' };
      }

      // 3. Update DB if changed (Only if credential exists in DB)
      if (credential.id && credential.supports_v3 !== supportsV3) {
        await prisma.googleCredential.update({
          where: { id: credential.id },
          data: { supports_v3: supportsV3 }
        });

        if (supportsV3) {
          await poolManager.addCredential(credential.id, true);
        }
      }

      return { supported: supportsV3, response: proxyResponse };
    } catch (e: any) {
      console.error(`[CredentialService] Check V3 failed for ${credential.id || 'RAW'}:`, e.message);
      return { supported: false, error: e.message };
    }
  }

}
