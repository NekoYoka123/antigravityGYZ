<template>
  <div class="flex flex-col h-full space-y-4">
    <!-- Toolbar -->
    <div class="flex flex-col md:flex-row md:justify-between md:items-center gap-4 bg-white p-4 rounded-2xl border border-gray-200 shadow-sm">
      <div class="flex items-center gap-4">
        <!-- Filter Dropdown -->
        <div class="relative group">
          <select v-model="filterStatus" @change="page=1; fetchCredentials()" 
            class="appearance-none bg-gray-50 border border-gray-200 pl-4 pr-10 py-2 text-gray-700 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 cursor-pointer hover:bg-white rounded-xl transition-all shadow-sm">
            <option value="ALL">📋 全部状态</option>
            <option value="ACTIVE">🟢 只看活跃</option>
            <option value="DEAD">🔴 只看失效</option>
            <option value="COOLING">🟡 冷却中</option>
          </select>
          <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">▼</div>
        </div>
      </div>

      <div class="flex items-center gap-4">
        <span class="text-xs font-bold text-gray-500 bg-gray-100 px-3 py-1 rounded-full border border-gray-200">TOTAL: {{ meta.total }}</span>
        <button @click="fetchCredentials" class="w-8 h-8 rounded-full bg-white border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-indigo-600 shadow-sm transition-all hover:rotate-180 duration-500">
          ↻
        </button>
      </div>
    </div>
    
    <!-- Table / List -->
    <div class="overflow-x-auto bg-white rounded-3xl border border-gray-200 shadow-sm">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="text-left bg-gray-50/50 border-b border-gray-100">
            <th class="px-6 py-4 text-[10px] font-black text-gray-400 uppercase tracking-widest">凭证信息</th>
            <th class="px-6 py-4 text-[10px] font-black text-gray-400 uppercase tracking-widest hidden md:table-cell">上传者</th>
            <th class="px-6 py-4 text-[10px] font-black text-gray-400 uppercase tracking-widest">状态</th>
            <th class="px-6 py-4 text-[10px] font-black text-gray-400 uppercase tracking-widest hidden md:table-cell">健康度</th>
            <th class="px-6 py-4 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-if="credentials.length === 0">
              <td colspan="5" class="px-6 py-12 text-center">
                <div class="flex flex-col items-center text-gray-400">
                  <span class="text-4xl mb-2">🍃</span>
                  <span class="font-medium">暂无相关数据</span>
                </div>
              </td>
          </tr>
          <tr v-for="cred in credentials" :key="cred.id" 
              class="group hover:bg-gray-50 transition-colors">
            
            <!-- ID & Name -->
            <td class="px-6 py-4">
              <div class="flex flex-col">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-black text-indigo-400 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">#{{ cred.id }}</span>
                  <span class="text-sm font-bold text-gray-700 truncate max-w-[150px]" :title="cred.name">{{ cred.name }}</span>
                </div>
                <div v-if="cred.google_email" class="mt-1 text-[11px] text-gray-500 font-mono truncate max-w-[220px]">
                  {{ cred.google_email }}
                </div>
              </div>
            </td>

            <!-- Owner -->
            <td class="px-6 py-4 hidden md:table-cell">
              <div class="flex items-center gap-2">
                <div class="w-6 h-6 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-[10px] text-gray-600 font-bold border border-white shadow-sm">
                  {{ cred.owner_email[0].toUpperCase() }}
                </div>
                <span class="text-xs font-medium text-gray-500">{{ cred.owner_email }}</span>
              </div>
            </td>

            <!-- Status -->
            <td class="px-6 py-4">
              <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border shadow-sm"
                :class="{
                  'bg-emerald-50 border-emerald-200 text-emerald-700': cred.status === 'ACTIVE',
                  'bg-amber-50 border-amber-200 text-amber-700': cred.status === 'COOLING',
                  'bg-rose-50 border-rose-200 text-rose-700': cred.status === 'DEAD',
                  'bg-slate-50 border-slate-200 text-slate-600': cred.status === 'VALIDATING'
                }">
                <span class="relative flex h-2 w-2">
                  <span v-if="cred.status === 'ACTIVE'" class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2" :class="{
                    'bg-emerald-500': cred.status === 'ACTIVE',
                    'bg-amber-500': cred.status === 'COOLING',
                    'bg-rose-500': cred.status === 'DEAD',
                    'bg-slate-500': cred.status === 'VALIDATING'
                  }"></span>
                </span>
                <span class="text-[10px] font-black tracking-wider">{{ cred.status }}</span>
              </div>
            </td>

            <!-- Error / Health -->
            <td class="px-6 py-4 hidden md:table-cell">
              <div v-if="cred.last_error" class="group/err relative flex items-center">
                <span class="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded border border-rose-100 cursor-help">
                  ⚠ {{ cred.last_error }}
                </span>
              </div>
              <div v-else class="text-xs text-emerald-600 font-bold flex items-center gap-1">
                <span class="text-lg">♥</span> 健康
              </div>
              <div class="text-[10px] text-gray-400 mt-1 font-mono">Failures: {{ cred.fail_count }}</div>
            </td>

            <!-- Actions -->
            <td class="px-6 py-4 text-right">
              <div class="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <!-- Toggle -->
                <button 
                  v-if="cred.status === 'DEAD'"
                  @click="toggleCredential(cred.id, true)"
                  class="w-8 h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-200 flex items-center justify-center shadow-sm transition-colors"
                  title="激活恢复"
                >
                  ⚡
                </button>
                <button 
                  v-else
                  @click="toggleCredential(cred.id, false)"
                  class="w-8 h-8 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-600 border border-amber-200 flex items-center justify-center shadow-sm transition-colors"
                  title="强制停用"
                >
                  ⏸
                </button>

                <!-- Delete -->
                <button 
                  @click="deleteCredential(cred.id)"
                  class="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 flex items-center justify-center shadow-sm transition-colors"
                  title="彻底删除"
                >
                  🗑
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="flex justify-center mt-6 gap-2" v-if="meta.total_pages > 1">
      <button 
        @click="changePage(-1)" 
        :disabled="page <= 1"
        class="px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold text-gray-700 shadow-sm"
      >
        ← 上一页
      </button>
      <span class="px-4 py-2 text-sm text-gray-500 font-mono">
        PAGE {{ page }} / {{ meta.total_pages }}
      </span>
      <button 
        @click="changePage(1)" 
        :disabled="page >= meta.total_pages"
        class="px-4 py-2 rounded-xl bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold text-gray-700 shadow-sm"
      >
        下一页 →
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { api } from '@/utils/api'; 

interface Credential {
  id: number;
  name: string;
  owner_email: string;
  google_email?: string;
  status: string;
  fail_count: number;
  last_validated: string;
  last_error: string | null;
}

const credentials = ref<Credential[]>([]);
const page = ref(1);
const filterStatus = ref('ALL');
const meta = reactive({ total: 0, total_pages: 1, limit: 10 });

const fetchCredentials = async () => {
  try {
    const res = await api.get('/admin/credentials', {
      params: {
        page: page.value,
        limit: 10,
        status: filterStatus.value
      }
    });
    credentials.value = res.data.data;
    Object.assign(meta, res.data.meta);
  } catch (err) {
    console.error('Failed to fetch credentials', err);
  }
};

const changePage = (delta: number) => {
  page.value += delta;
  fetchCredentials();
};

const toggleCredential = async (id: number, enable: boolean) => {
  try {
    await api.post(`/admin/credentials/${id}/toggle`, { enable });
    await fetchCredentials();
  } catch (err) {
    alert('状态修改失败');
  }
};

const deleteCredential = async (id: number) => {
  if (!confirm(`确认删除 #${id}？这会彻底移除该凭证。`)) return;
  try {
    await api.delete(`/admin/credentials/${id}`);
    await fetchCredentials();
  } catch (err) {
    alert('删除失败');
  }
};

onMounted(() => {
  fetchCredentials();
});
</script>

<style scoped>
/* Smooth scrollbar for the table area */
.overflow-auto::-webkit-scrollbar {
  width: 6px;
}
.overflow-auto::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
}
.overflow-auto::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 10px;
}
.overflow-auto::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.5);
}
</style>
