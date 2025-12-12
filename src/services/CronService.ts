import cron from 'node-cron';
import { PrismaClient, CredentialStatus } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const POOL_KEY = 'GLOBAL_CREDENTIAL_POOL';

export class CronService {
  constructor() {
    this.initJobs();
  }

  private initJobs() {
    // 1. Daily Quota Reset
    // Schedule task for 00:00 every day (UTC+8)
    cron.schedule('0 0 * * *', async () => {
      console.log(`[CronService] Starting daily quota reset at ${new Date().toISOString()}...`);
      await this.resetDailyQuotas();
    }, {
      scheduled: true,
      timezone: "Asia/Shanghai"
    });
    
    // 2. Cooled Credentials Restoration
    // Run every 10 minutes to check if any cooling period has expired
    cron.schedule('*/10 * * * *', async () => {
        await this.restoreCooledCredentials();
    });

    console.log('[CronService] Jobs scheduled: Daily Quota Reset (00:00 UTC+8), Cooling Restoration (every 10m).');
  }

  /**
   * Resets 'today_used' to 0 for ALL users.
   */
  async resetDailyQuotas() {
    try {
      const result = await prisma.user.updateMany({
        data: {
          today_used: 0,
        },
      });
      console.log(`[CronService] Daily reset complete. Reset ${result.count} users.`);
    } catch (error) {
      console.error('[CronService] Failed to reset daily quotas:', error);
    }
  }

  /**
   * Checks for credentials that have passed their cooling period and reactivates them.
   */
  async restoreCooledCredentials() {
      try {
          const now = new Date();
          
          // Find expired cooling credentials
          const cooledCreds = await prisma.googleCredential.findMany({
              where: {
                  status: CredentialStatus.COOLING,
                  cooling_expires_at: {
                      lte: now
                  }
              }
          });

          if (cooledCreds.length === 0) return;

          console.log(`[CronService] Found ${cooledCreds.length} credentials ready to be restored.`);

          for (const cred of cooledCreds) {
              // Transaction: Update DB -> Push to Redis
              // Note: Redis push isn't part of Prisma transaction, so we do it after.
              
              await prisma.googleCredential.update({
                  where: { id: cred.id },
                  data: {
                      status: CredentialStatus.ACTIVE,
                      cooling_expires_at: null,
                      fail_count: 0 // Reset fail count on restoration
                  }
              });

              await redis.rpush(POOL_KEY, String(cred.id));
              console.log(`[CronService] Restored Credential ${cred.id} to ACTIVE pool.`);
          }

      } catch (error) {
          console.error('[CronService] Failed to restore cooled credentials:', error);
      }
  }
}
