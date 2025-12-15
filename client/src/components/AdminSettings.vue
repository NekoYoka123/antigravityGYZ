<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../utils/api';
import AdminQuotaSettings from './AdminQuotaSettings.vue';

const isSharedMode = ref(true);
const forceDiscordBind = ref(false);
const isLoading = ref(false);
const message = ref('');

// Announcement
const announcementContent = ref('');
const isPublishing = ref(false);
const publishMessage = ref('');

onMounted(async () => {
  await fetchSettings();
  await fetchAnnouncement();
});

const fetchSettings = async () => {
  try {
    const res = await api.get('/admin/settings');
    isSharedMode.value = res.data.enable_shared_mode;
    forceDiscordBind.value = !!res.data.force_discord_bind;
  } catch (e) {
    console.error('Failed to fetch settings', e);
  }
};

const fetchAnnouncement = async () => {
    try {
        const res = await api.get('/announcement');
        if (res.data.content) announcementContent.value = res.data.content;
    } catch (e) { console.error(e); }
};

const publishAnnouncement = async () => {
    isPublishing.value = true;
    publishMessage.value = '';
    try {
        await api.post('/admin/announcement', { content: announcementContent.value });
        publishMessage.value = '公告已发布！所有用户下次访问将强制弹出。';
        setTimeout(() => publishMessage.value = '', 5000);
    } catch (e) {
        publishMessage.value = '发布失败';
    } finally {
        isPublishing.value = false;
    }
};

const toggleMode = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    // Toggle the value
    const newValue = !isSharedMode.value;
    await api.post('/admin/settings', { enable_shared_mode: newValue });
    isSharedMode.value = newValue;
    message.value = newValue ? '已开启共享模式：所有用户均可使用' : '已开启严格模式：仅上传凭证用户可使用';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};

const toggleForceDiscordBind = async () => {
  isLoading.value = true;
  message.value = '';
  try {
    const newValue = !forceDiscordBind.value;
    await api.post('/admin/settings', { force_discord_bind: newValue });
    forceDiscordBind.value = newValue;
    message.value = newValue ? '已开启强制 Discord 授权' : '已关闭强制 Discord 授权';
  } catch (e) {
    message.value = '设置更新失败';
  } finally {
    isLoading.value = false;
  }
};

// Reference to AdminQuotaSettings component to call its save method
const quotaSettingsRef = ref();

const saveSettings = async () => {
    if (quotaSettingsRef.value) {
        await quotaSettingsRef.value.saveSettings();
        message.value = quotaSettingsRef.value.message;
    }
};
</script>

<template>
  <div class="space-y-3">
    <!-- Mode Settings -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                    <span>⚙️ 运行模式</span>
                </h2>
                <div class="h-4 w-[1px] bg-white/10"></div>
                <div class="flex flex-col">
                    <h3 class="font-medium text-sm" :class="isSharedMode ? 'text-green-400' : 'text-orange-400'">
                        {{ isSharedMode ? '共享模式 (Shared Mode)' : '严格模式 (Strict Mode)' }}
                    </h3>
                    <p class="text-xs text-[#A5B4FC] opacity-60">
                        {{ isSharedMode
                            ? '允许所有注册用户使用共享凭证池'
                            : '仅允许管理员和贡献者使用服务' }}
                    </p>
                </div>
            </div>

            <button
                @click="toggleMode"
                :disabled="isLoading"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                :class="isSharedMode ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-white/10'"
            >
                <span class="sr-only">切换模式</span>
                <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                :class="isSharedMode ? 'translate-x-6' : 'translate-x-1'"
                />
            </button>
        </div>
        
        <p v-if="message" class="mt-2 text-xs font-medium text-[#C4B5FD] animate-pulse pl-1">
        {{ message }}
        </p>
    </div>

    <!-- Force Discord Bind -->
    <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)]">
        <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
                <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                    <span>🔒 强制授权</span>
                </h2>
                <div class="h-4 w-[1px] bg-white/10"></div>
                <div class="flex flex-col">
                    <h3 class="font-medium text-sm" :class="forceDiscordBind ? 'text-red-400' : 'text-[#A5B4FC]'">
                        {{ forceDiscordBind ? '已开启：未授权用户将被拦截' : '已关闭：不强制弹窗' }}
                    </h3>
                    <p class="text-xs text-[#A5B4FC] opacity-60">
                        开启后，普通用户首次进入控制台会强制弹出 Discord 授权提示
                    </p>
                </div>
            </div>

            <button
                @click="toggleForceDiscordBind"
                :disabled="isLoading"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0"
                :class="forceDiscordBind ? 'bg-gradient-to-r from-red-500 to-rose-600' : 'bg-white/10'"
            >
                <span class="sr-only">切换强制授权</span>
                <span
                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow"
                :class="forceDiscordBind ? 'translate-x-6' : 'translate-x-1'"
                />
            </button>
        </div>
    </div>

    <!-- Quota & Rate Limit Settings (Integrated) -->
    <AdminQuotaSettings ref="quotaSettingsRef">
        <template #announcement>
            <!-- Announcement Editor (Injected into AdminQuotaSettings grid) -->
            <div class="bg-white/5 backdrop-blur-xl border border-purple-500/30 rounded-2xl p-4 shadow-[0_0_15px_rgba(139,92,246,0.1)] h-full flex flex-col w-full">
                <div class="flex items-center gap-4 mb-3">
                    <h2 class="text-lg font-bold text-[#C4B5FD] flex items-center gap-2 whitespace-nowrap">
                        <span>📢 全局公告</span>
                    </h2>
                    <div class="h-4 w-[1px] bg-white/10"></div>
                    <p class="text-xs text-[#A5B4FC] opacity-60">发布后强制弹窗</p>
                </div>
                
                <div class="relative group flex-1">
                    <textarea
                        v-model="announcementContent"
                        class="w-full h-full bg-black/20 border border-white/10 rounded-xl p-3 text-sm text-white focus:border-[#8B5CF6] outline-none transition group-hover:border-[#8B5CF6]/50 group-hover:shadow-[0_0_10px_rgba(139,92,246,0.1)] resize-none"
                        placeholder="在此输入公告内容..."
                    ></textarea>
                </div>

                <div class="flex justify-end items-center gap-4 mt-3">
                    <span v-if="publishMessage" class="text-xs font-bold text-green-400 animate-pulse">{{ publishMessage }}</span>
                    <button
                        @click="publishAnnouncement"
                        :disabled="isPublishing"
                        class="px-5 py-1.5 bg-gradient-to-br from-[#8B5CF6] to-[#4338CA] text-white rounded-lg font-bold text-sm hover:opacity-90 transition shadow-lg shadow-indigo-500/20 disabled:opacity-50 hover:scale-105 hover:shadow-[0_0_20px_rgba(139,92,246,0.5)] duration-300"
                    >
                        {{ isPublishing ? '发布中...' : '发布公告' }}
                    </button>
                </div>
            </div>
        </template>
    </AdminQuotaSettings>

    <!-- Save Config Button -->
    <div class="flex justify-end items-center gap-4 pt-4 border-t border-white/10">
        <span v-if="message" class="text-sm font-bold animate-pulse" :class="message.includes('失败') ? 'text-red-400' : 'text-green-400'">
            {{ message }}
        </span>
        <button
            @click="saveSettings"
            :disabled="isLoading"
            class="px-8 py-3 bg-gradient-to-br from-[#8B5CF6] to-[#4338CA] hover:opacity-90 text-white font-bold rounded-full shadow-lg shadow-indigo-500/30 transition-all disabled:opacity-50 hover:scale-105 hover:shadow-[0_0_20px_rgba(139,92,246,0.5)] duration-300"
        >
            <span v-if="isLoading" class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></span>
            {{ isLoading ? '保存中...' : '保存配置' }}
        </button>
    </div>
  </div>
</template>
