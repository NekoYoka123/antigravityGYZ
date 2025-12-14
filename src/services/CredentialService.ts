import { PrismaClient, CredentialStatus } from '@prisma/client';
import { request } from 'undici';
import { z } from 'zod';
import { CredentialPoolManager } from './CredentialPoolManager';
import { getUserAgent } from '../utils/system';

const prisma = new PrismaClient();
const poolManager = new CredentialPoolManager();

// Zod schema for input validation
const CredentialInputSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  project_id: z.string().optional(),
});

export class CredentialService {
  /**
   * Upload and verify a Google OAuth2 Credential.
   * Logic: Parse -> Get Access Token -> Verify with Cloud Code API -> Save & Upgrade User
   */
  async uploadAndVerify(userId: number, jsonContent: string, requireV3: boolean = false) {
    // 1. Parse and Validate JSON structure
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonContent);
    } catch (e) {
      throw new Error('Invalid JSON format');
    }

    // Support both flat and nested (web/installed) formats
    const clientId = parsedJson.client_id || parsedJson.web?.client_id || parsedJson.installed?.client_id;
    const clientSecret = parsedJson.client_secret || parsedJson.web?.client_secret || parsedJson.installed?.client_secret;
    const refreshToken = parsedJson.refresh_token;
    const projectId = parsedJson.project_id; // project_id is now mandatory, no fallback

    if (!clientId || !clientSecret || !refreshToken || !projectId) {
        throw new Error('Invalid Credential JSON: Missing client_id, client_secret, refresh_token, or project_id');
    }

    // 2. Exchange Refresh Token for Access Token
    const accessToken = await this.refreshAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) {
       throw new Error('Failed to refresh access token. The refresh token might be expired or invalid.');
    }

    // 3. Active Validation against Cloud Code API
    const isValid = await this.verifyCloudCodeAccess(accessToken, projectId);
    if (!isValid) {
      throw new Error('Credential validation failed: Could not access Cloud Code API.');
    }

    // 3.1 Check for Gemini 3.0 Support
    let supportsV3 = false;
    try {
        supportsV3 = await this.verifyCloudCodeAccess(accessToken, projectId, 'gemini-3-pro-preview');
        if (supportsV3) {
            console.log(`[CredentialService] User ${userId} credential supports Gemini 3.0`);
        }
    } catch (e) {
        if (requireV3) {
            throw new Error('Credential validation failed: Could not access Gemini 3.0 (gemini-3-pro-preview).');
        }
        console.warn(`[CredentialService] Gemini 3.0 check failed for User ${userId}`);
    }

    // 4. Save to DB and Upgrade User (Transaction)
    try {
      // Fetch Config
      const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
      let quotaContributor = 1500;
      let quotaV3 = 3000;
      if (configSetting) {
          try {
              const conf = JSON.parse(configSetting.value);
              quotaContributor = conf.quota?.contributor ?? 1500;
              quotaV3 = conf.quota?.v3_contributor ?? 3000;
          } catch (e) {}
      }

      const result = await prisma.$transaction(async (tx) => {
        // Create Credential
        const credential = await tx.googleCredential.create({
          data: {
            owner_id: userId,
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            project_id: projectId,
            is_active: true,
            supports_v3: supportsV3,
            status: CredentialStatus.ACTIVE,
            last_validated_at: new Date(),
          },
        });

        // Upgrade User to Level 1 (Mark as contributor)
        // Note: daily_limit is now calculated dynamically in ProxyController (Base + 1000 * Creds)
        await tx.user.update({
          where: { id: userId },
          data: {
            level: 1
          },
        });

        return credential;
      });

      console.log(`[CredentialService] Success: User ${userId} upgraded. Credential ID: ${result.id}`);
      
      // Add to Redis Pool immediately
      await poolManager.addCredential(result.id, supportsV3);
      
      return result;

    } catch (error: any) {
      console.error(`[CredentialService] DB Transaction failed for User ${userId}:`, error);
      throw new Error('Internal Error: Failed to save credential.');
    }
  }

  /**
   * Swaps a refresh token for a short-lived access token using undici.
   * Caches the token in Redis to improve performance.
   */
  private async refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string | null> {
    const cacheKey = `ACCESS_TOKEN:${clientId.slice(0, 10)}:${refreshToken.slice(-10)}`; // Simple hash key
    
    // 1. Try Cache
    // Create a local redis instance since we can't access poolManager's private one
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    const cached = await redis.get(cacheKey);
    if (cached) {
        redis.disconnect(); // Don't forget to close connection
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
        redis.disconnect();
        return null;
      }

      const data = await body.json() as any;
      const accessToken = data.access_token;
      
      if (accessToken) {
          // Cache for 55 minutes (expires_in is usually 3600s)
          await redis.set(cacheKey, accessToken, 'EX', 3300);
      }
      
      redis.disconnect();
      return accessToken || null;

    } catch (error) {
      console.error('[CredentialService] Token Refresh Network Error:', error);
      redis.disconnect();
      return null;
    }
  }

  /**
   * Verifies the credential by making a real request to the internal Cloud Code API.
   * Uses the correct wrapper structure found in gemini-cli-core.
   */
  public async verifyCloudCodeAccess(accessToken: string, projectId: string, modelName: string = 'gemini-2.5-flash'): Promise<boolean> {
    const baseUrl = process.env.GOOGLE_CLOUD_CODE_URL || 'https://cloudcode-pa.googleapis.com';
    const targetUrl = `${baseUrl}/v1internal:generateContent`;
    
    // Use a more complete payload to avoid 400 errors from strict models
    const payload = {
      model: modelName, 
      project: projectId,
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
        } catch(e) {
            console.error('[CredentialService] Failed to parse validation response:', e);
            return false;
        }
      }

      const errorText = await body.text();
      console.error(`[CredentialService] Validation Failed for ${modelName} (${statusCode}):`, errorText);
      
      // If it's a 403, we now treat it as a failure because this is an actual generation attempt.
      // If generation fails with 403, the credential is not usable for this model.
      
      throw new Error(`API Error ${statusCode}: ${errorText.substring(0, 200)}`);

    } catch (error: any) {
      console.error(`[CredentialService] Network/API Error for ${modelName}:`, error.message);
      throw error; // Propagate up
    }
  }

  /**
   * Manually check if a stored credential supports Gemini 3.0
   * Returns object with detailed result
   */
  async checkV3Support(credential: any): Promise<{ supported: boolean; error?: string }> {
      try {
          // 1. Refresh Token
          const accessToken = await this.refreshAccessToken(credential.client_id, credential.client_secret, credential.refresh_token);
          if (!accessToken) throw new Error('Failed to refresh token');

          // 2. Verify V3
          // Now verifyCloudCodeAccess throws on error, so we catch it below
          await this.verifyCloudCodeAccess(accessToken, credential.project_id, 'gemini-3-pro-preview');

          // If no error thrown, it's supported
          const supportsV3 = true;

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

          return { supported: true };
      } catch (e: any) {
          console.error(`[CredentialService] Check V3 failed for ${credential.id || 'RAW'}:`, e.message);
          return { supported: false, error: e.message };
      }
  }
}