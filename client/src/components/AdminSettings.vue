<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../utils/api';

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
</script>

<template>
  <div class="space-y-6">
    <!-- Mode Settings -->
    <div class="bg-white dark:bg-gray-800 rounded-3xl shadow p-6">
        <h2 class="text-xl font-bold mb-4 text-gray-800 dark:text-white flex items-center gap-2">
            <span>⚙️ 运行模式</span>
        </h2>
        
        <div class="flex items-center justify-between">
        <div>
            <h3 class="font-medium text-lg" :class="isSharedMode ? 'text-green-600' : 'text-orange-600'">
            {{ isSharedMode ? '共享模式 (Shared Mode)' : '严格模式 (Strict Mode)' }}
            </h3>
            <p class="text-sm text-gray-500 mt-1">
            {{ isSharedMode 
                ? '当前允许所有注册用户使用共享凭证池，消耗各自的每日额度。' 
                : '当前仅允许管理员和已上传有效凭证的贡献者使用服务。' }}
            </p>
        </div>

        <button 
            @click="toggleMode" 
            :disabled="isLoading"
            class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            :class="isSharedMode ? 'bg-green-500' : 'bg-gray-300'"
        >
            <span class="sr-only">切换模式</span>
            <span
            class="inline-block h-6 w-6 transform rounded-full bg-white transition-transform shadow ring-0"
            :class="isSharedMode ? 'translate-x-7' : 'translate-x-1'"
            />
        </button>
        </div>
        
        <p v-if="message" class="mt-3 text-sm font-medium text-indigo-600 animate-pulse">
        {{ message }}
        </p>
    </div>

    <!-- Force Discord Bind -->
    <div class="bg-white dark:bg-gray-800 rounded-3xl shadow p-6">
        <h2 class="text-xl font-bold mb-4 text-gray-800 dark:text-white flex items-center gap-2">
            <span>🔒 强制 Discord 授权</span>
        </h2>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-medium text-lg" :class="forceDiscordBind ? 'text-red-600' : 'text-gray-600'">
              {{ forceDiscordBind ? '已开启：未授权用户将被拦截并弹窗' : '已关闭：不强制弹窗' }}
            </h3>
            <p class="text-sm text-gray-500 mt-1">
              开启后，普通用户首次进入控制台会强制弹出授权提示，完成 Discord 授权后不再弹出。管理员不受此限制。
            </p>
          </div>
          <button 
              @click="toggleForceDiscordBind" 
              :disabled="isLoading"
              class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              :class="forceDiscordBind ? 'bg-red-500' : 'bg-gray-300'"
          >
              <span class="sr-only">切换强制授权</span>
              <span
              class="inline-block h-6 w-6 transform rounded-full bg-white transition-transform shadow ring-0"
              :class="forceDiscordBind ? 'translate-x-7' : 'translate-x-1'"
              />
          </button>
        </div>
    </div>

    <!-- Announcement Editor -->
    <div class="bg-white dark:bg-gray-800 rounded-3xl shadow p-6">
        <h2 class="text-xl font-bold mb-4 text-gray-800 dark:text-white flex items-center gap-2">
            <span>📢 全局公告</span>
        </h2>
        <p class="text-sm text-gray-500 mb-4">发布新公告后，所有用户在下次刷新或登录时，将会看到强制弹窗（需阅读5秒）。</p>
        
        <textarea 
            v-model="announcementContent" 
            rows="5"
            class="w-full bg-gray-50 border border-gray-200 rounded-xl p-4 text-gray-800 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
            placeholder="在此输入公告内容（支持简单文本换行）..."
        ></textarea>

        <div class="flex justify-end items-center gap-4 mt-4">
            <span v-if="publishMessage" class="text-sm font-bold text-green-600 animate-pulse">{{ publishMessage }}</span>
            <button 
                @click="publishAnnouncement" 
                :disabled="isPublishing"
                class="px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition shadow-lg shadow-indigo-500/20 disabled:opacity-50"
            >
                {{ isPublishing ? '发布中...' : '发布公告' }}
            </button>
        </div>
    </div>
  </div>
</template>
