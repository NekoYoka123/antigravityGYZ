<template>
  <div class="min-h-screen font-sans text-white relative flex overflow-hidden">
    <AnimatedBackground />

    <!-- 侧边栏 (Slide Left Entrance) -->
    <aside 
      v-motion-slide-left
      class="hidden md:flex flex-col w-24 lg:w-64 h-screen fixed left-0 top-0 bg-white/5 backdrop-blur-xl border-r border-white/10 z-20"
    >
      <div class="p-8 flex items-center justify-center lg:justify-start gap-3">
        <div class="w-10 h-10 bg-gradient-to-br from-red-500 to-yellow-500 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg">☭</div>
        <span class="hidden lg:block text-xl font-black tracking-tight text-yellow-100">星星人民公益站 ✨</span>
      </div>

      <!-- User Profile Section -->
      <div class="p-6 border-b border-white/10 flex flex-col items-center lg:items-start gap-4 flex-shrink-0">
        <div class="relative group cursor-pointer">
            <div class="w-16 h-16 rounded-2xl shadow-lg border-2 border-white/20 overflow-hidden group-hover:border-pink-400 transition-all bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-2xl font-bold">
                <img v-if="userInfo.discordAvatar" :src="userInfo.discordAvatar" class="w-full h-full object-cover" alt="Discord Avatar">
                <span v-else>{{ userInfo.email?.charAt(0).toUpperCase() }}</span>
            </div>
            <div class="absolute -bottom-1 -right-1 bg-green-500 w-4 h-4 rounded-full border-2 border-black"></div>
        </div>
        <div class="hidden lg:block overflow-hidden w-full">
            <div class="font-bold truncate text-lg">{{ userInfo.email?.split('@')[0] }}</div>
            <div class="text-xs text-white/40 truncate">{{ userInfo.email }}</div>
            <button @click="showChangePwModal = true" class="text-[10px] mt-2 bg-white/10 hover:bg-white/20 px-2 py-1 rounded text-white/60 transition">修改密码</button>
        </div>
      </div>

      <nav class="flex-1 px-4 py-8 space-y-4 overflow-y-auto custom-scrollbar">
        <button @click="currentTab = 'home'" :class="tabClass('home')">
          <span class="text-2xl">🏠</span>
          <span class="hidden lg:block">概览</span>
        </button>
        <button @click="currentTab = 'antigravity'" :class="antigravityTabClass">
          <span class="text-2xl">🚀</span>
          <span class="hidden lg:block">反重力</span>
        </button>
        <button @click="currentTab = 'upload'" :class="tabClass('upload')">
          <span class="text-2xl">🎁</span>
          <span class="hidden lg:block">上传</span>
        </button>
        <button @click="currentTab = 'keys'" :class="tabClass('keys')">
          <span class="text-2xl">🔑</span>
          <span class="hidden lg:block">密钥</span>
        </button>
      </nav>

    </aside>

    <main class="flex-1 md:ml-24 lg:ml-64 min-h-screen overflow-y-auto p-4 md:p-10 pb-24 relative z-10">
      
      <!-- Header -->
      <header class="flex justify-between items-center mb-6 md:mb-10" v-motion-slide-top>
        <div>
          <h1 class="text-3xl md:text-5xl font-black tracking-tighter mb-2">{{ pageTitle }}</h1>
          <p class="text-white/60 text-sm md:text-lg">今天是充满希望的一天 ✨</p>
        </div>
        <div class="flex items-center gap-2">
          <button @click="logout" class="text-xs px-3 py-1 rounded-full bg-white/10 hover:bg-red-500/20 hover:text-red-300 font-bold transition-colors">
            退出
          </button>
          <button v-if="!userInfo.discordId" @click="bindDiscord" class="text-xs px-3 py-1 rounded-full bg-[#5865F2] hover:bg-[#4752C4] font-bold">
            绑定 Discord
          </button>
          <button v-if="!userInfo.discordId" @click="bindDiscordApp" class="text-xs px-3 py-1 rounded-full bg-black/30 hover:bg-black/40 border border-white/10 font-bold">
            在 App 中绑定
          </button>
          <button @click="currentTab = 'upload'" class="text-xs px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 font-bold">
            上传
          </button>
        </div>
      </header>
      
      <div v-if="!userInfo.discordId" class="mb-6">
        <div class="bg-[#4752C4]/20 border border-[#5865F2]/30 rounded-2xl p-4 flex items-center justify-between">
          <div class="text-sm">
            <div class="font-bold">请先绑定 Discord 账户</div>
            <div class="text-white/60">绑定完成后才能使用所有功能。</div>
          </div>
          <button @click="bindDiscord" class="px-4 py-2 bg-[#5865F2] hover:bg-[#4752C4] rounded-xl font-bold">立即绑定</button>
        </div>
      </div>

      <!-- 1. 概览 (Home) -->
      <div v-if="currentTab === 'home'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 auto-rows-[170px]">
        
        <!-- 今日用量仪表盘（左侧卡片，保留仪表盘） -->
        <div 
            v-motion
            :initial="{ opacity: 0, y: 50 }"
            :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, delay: 100 } }"
            :hover="{ scale: 1.01 }"
            class="col-span-1 lg:col-span-2 row-span-2 bg-[#ccfbf1] rounded-[30px] p-5 text-teal-950 flex flex-col shadow-xl border border-white/50 relative overflow-hidden"
        >
             <div class="mb-1 z-10">
               <div class="text-xs font-black uppercase tracking-widest opacity-60">今日用量</div>
             </div>
             <div class="flex-1 flex items-center justify-center -mt-4 transform scale-90">
                <GaugeChart :current="stats.today_used" :max="stats.daily_limit" progressColor="#0f766e" textColor="text-teal-900" />
             </div>
             
             <!-- Model Breakdown -->
           <div class="grid grid-cols-3 gap-2 z-10">
                <div class="bg-white/40 rounded-lg py-2 flex flex-col items-center">
                    <div class="text-[9px] font-black opacity-50 uppercase">gemini-2.5-flash</div>
                    <div class="font-bold text-sm">{{ stats.model_usage?.['gemini-2.5-flash'] || 0 }}</div>
                </div>
                <div class="bg-white/40 rounded-xl p-2 flex flex-col items-center">
                    <div class="text-[10px] font-black opacity-50 uppercase">gemini-2.5-pro</div>
                    <div class="font-bold text-lg">{{ stats.model_usage?.['gemini-2.5-pro'] || 0 }}</div>
                </div>
                <div class="bg-white/40 rounded-xl p-2 flex flex-col items-center">
                    <div class="text-[10px] font-black opacity-50 uppercase">gemini-3-pro-preview</div>
                    <div class="font-bold text-lg text-purple-600">{{ stats.model_usage?.['gemini-3-pro-preview'] || 0 }}</div>
                </div>
           </div>
            <div class="mt-2 text-[11px] font-bold text-teal-900 text-center">
              合计：{{ 
                (stats.model_usage?.['gemini-2.5-flash'] || 0) + 
                (stats.model_usage?.['gemini-2.5-pro'] || 0) + 
                (stats.model_usage?.['gemini-3-pro-preview'] || 0) 
              }} 次
            </div>
        </div>

        <!-- 公告（中间卡片） -->
        <div 
            @click="openAnnouncementPreview"
            v-motion
            :initial="{ opacity: 0, y: 50 }"
            :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, delay: 200 } }"
            :hover="{ scale: 1.01 }"
            class="col-span-1 row-span-2 bg-white/90 rounded-[30px] p-5 text-gray-800 flex flex-col shadow-xl cursor-pointer hover:bg-white transition-colors group"
        >
           <div class="flex-1 overflow-y-auto pr-2 space-y-3 text-xs">
             <div v-if="announcementData.content" class="whitespace-pre-line">{{ announcementData.content }}</div>
           </div>
        </div>

        <!-- 欢迎卡片（右侧上传卡片） -->
        <div 
            v-motion
            :initial="{ opacity: 0, y: 50 }"
            :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, delay: 300 } }"
            :hover="{ scale: 1.01 }"
            class="col-span-1 md:col-span-1 lg:col-span-1 row-span-2 bg-gradient-to-br from-violet-200 to-pink-200 rounded-[30px] p-5 text-indigo-950 flex flex-col justify-between shadow-xl border border-white/50"
        >
          <div>
            <div class="text-xs font-black uppercase tracking-widest opacity-60 mb-2">当前等级</div>
            <div class="text-4xl font-black mb-2">{{ userTitle }}</div>
            <div class="text-base font-medium opacity-80 leading-relaxed">
              {{ welcomeMessage }}
            </div>
          </div>
          <button @click="currentTab = 'upload'" class="self-start px-6 py-2 bg-indigo-950 text-white rounded-full font-bold hover:bg-indigo-800 transition-colors shadow-lg text-sm">
            去升级 →
          </button>
        </div>

        <!-- 反重力仪表盘 (Combined & Compact) -->
        <div
          v-motion
          :initial="{ opacity: 0, y: 50 }"
          :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, delay: 350 } }"
          :hover="{ scale: 1.01 }"
          class="col-span-1 md:col-span-2 lg:col-span-4 row-span-1 rounded-[30px] overflow-hidden shadow-xl flex flex-col md:flex-row border border-white/20"
        >
          <!-- Left: Claude -->
          <div class="flex-1 bg-gradient-to-br from-purple-900/40 to-fuchsia-900/40 p-4 text-purple-200 flex flex-col relative border-b md:border-b-0 md:border-r border-white/10">
            <div class="text-lg uppercase tracking-widest opacity-80 font-black mb-1 text-center">Antigravity • Claude 4.5</div>
            <div class="flex-1 flex items-center justify-center">
              <div class="h-24 w-40 flex items-center justify-center transform scale-90">
                <GaugeChart
                  :current="stats.antigravity_usage?.claude || 0"
                  :max="stats.antigravity_usage?.limits?.claude || 100"
                  progressColor="#a78bfa"
                  textColor="text-purple-200"
                />
              </div>
            </div>
          </div>

          <!-- Right: Gemini -->
          <div class="flex-1 bg-gradient-to-br from-cyan-900/40 to-teal-900/40 p-4 text-cyan-200 flex flex-col relative">
            <div class="text-lg uppercase tracking-widest opacity-80 font-black mb-1 text-center">Antigravity • Gemini 3.0</div>
            <div class="flex-1 flex flex-col items-center justify-center relative">
              <div class="h-24 w-40 flex items-center justify-center transform scale-90">
                <GaugeChart
                  :current="stats.antigravity_usage?.gemini3 || 0"
                  :max="stats.antigravity_usage?.limits?.gemini3 || 200"
                  progressColor="#22d3ee"
                  textColor="text-cyan-200"
                />
              </div>
              <button @click="currentTab = 'antigravity'" class="absolute bottom-0 right-0 px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold transition-all border border-white/10 shadow-lg z-10">
                上传凭证
              </button>
            </div>
          </div>
        </div>

                  <!-- 管理员入口 (Admin Zone) -->
                <div v-if="isAdmin" 
                    v-motion
                    :initial="{ opacity: 0, y: 50 }"
                    :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, delay: 400 } }"
                    class="col-span-1 md:col-span-2 lg:col-span-4 row-span-auto mt-8 space-y-6"
                >
                  <div class="flex items-center gap-4 mb-2 px-2">
                    <div class="h-px bg-white/20 flex-1"></div>
                    <h3 class="text-xs font-black text-white/40 uppercase tracking-[0.2em]">👑 管理员控制中心</h3>
                    <div class="h-px bg-white/20 flex-1"></div>
                  </div>
        
                  <!-- Global Settings -->
                  <AdminSettings />
        
                  <!-- Admin Stats Widgets -->
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                     
                                  <!-- 1. Global Capacity -->
                                  <div class="group bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl border border-white/10 rounded-[30px] p-5 hover:bg-white/15 transition-all duration-300">
                                     <div class="flex items-start justify-between mb-2">
                                       <div>
                                         <h4 class="text-[10px] font-black text-indigo-200 uppercase tracking-widest mb-1">全局算力负载</h4>
                                         <span class="text-xl font-bold">⚡ 综合负载</span>
                                       </div>
                                     </div>
                                     <div class="flex items-center gap-4">
                                         <div class="flex-1 transform scale-100">
                                            <!-- Gauge shows TOTAL Usage vs TOTAL Capacity -->
                                            <GaugeChart 
                                                :current="adminStats.overview.global_usage" 
                                                :max="adminStats.overview.global_capacity || 1" 
                                                progressColor="#818cf8" 
                                                textColor="text-white" 
                                            />
                                         </div>
                                         <div class="flex flex-col gap-2 w-1/3">
                                             <div class="bg-black/20 rounded-lg p-1.5 text-center">
                                                 <div class="text-[9px] text-white/50">Flash</div>
                                                 <div class="text-[10px] font-bold">
                                                     {{ adminStats.overview.model_usage?.flash || 0 }} <span class="opacity-50">/ {{ (adminStats.overview.capacities?.flash || 0) / 1000 }}k</span>
                                                 </div>
                                             </div>
                                             <div class="bg-black/20 rounded-lg p-1.5 text-center">
                                                 <div class="text-[9px] text-white/50">2.5 Pro</div>
                                                 <div class="text-[10px] font-bold">
                                                     {{ adminStats.overview.model_usage?.pro || 0 }} <span class="opacity-50">/ {{ adminStats.overview.capacities?.pro || 0 }}</span>
                                                 </div>
                                             </div>
                                             <div class="bg-black/20 rounded-lg p-1.5 text-center border border-purple-500/30">
                                                 <div class="text-[9px] text-purple-300">3.0 Pro</div>
                                                 <div class="text-[10px] font-bold text-purple-200">
                                                     {{ adminStats.overview.model_usage?.v3 || 0 }} <span class="opacity-50">/ {{ adminStats.overview.capacities?.v3 || 0 }}</span>
                                                 </div>
                                             </div>
                                         </div>
                                     </div>
                                  </div>                     <!-- 2. Health Status -->
                     <div class="group bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl border border-white/10 rounded-[30px] p-5 hover:bg-white/15 transition-all duration-300">
                        <div class="flex items-center justify-between mb-4">
                          <h4 class="text-[10px] font-black text-emerald-200 uppercase tracking-widest">凭证健康度</h4>
                        </div>
                        <div class="flex flex-col items-center justify-center h-full pb-2">
                           <div class="text-4xl font-black text-emerald-400 mb-1 drop-shadow-lg">{{ adminStats.overview.active_credentials }}</div>
                           <div class="text-xs font-bold text-white/60 mb-3">活跃凭证</div>
                           
                           <div class="w-full bg-black/20 h-2 rounded-full overflow-hidden flex">
                              <div class="bg-emerald-500 h-full transition-all duration-1000" :style="{ width: (adminStats.overview.active_credentials / (adminStats.overview.total_credentials || 1) * 100) + '%' }"></div>
                              <div class="bg-rose-500 h-full transition-all duration-1000 flex-1"></div>
                           </div>
                           <div class="flex justify-between w-full mt-2 text-[9px] font-black text-white/30 uppercase">
                              <span>{{ adminStats.overview.active_credentials }} Active</span>
                              <span>{{ adminStats.overview.dead_credentials }} Dead</span>
                           </div>
                        </div>
                     </div>
        
                                  <!-- 3. Top Users Leaderboard -->
                                  <div class="group bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl border border-white/10 rounded-[30px] p-5 hover:bg-white/15 transition-all duration-300 flex flex-col">
                                     <div class="flex items-center justify-between mb-2">
                                       <h4 class="text-[10px] font-black text-amber-200 uppercase tracking-widest">Top 25 🏆</h4>
                                       <div class="flex gap-1">
                                           <button @click="leaderboardPage--" :disabled="leaderboardPage === 1" class="w-5 h-5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-[10px]">←</button>
                                           <span class="text-[10px] font-mono pt-1">{{ leaderboardPage }}/5</span>
                                           <button @click="leaderboardPage++" :disabled="leaderboardPage === 5" class="w-5 h-5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-[10px]">→</button>
                                       </div>
                                     </div>
                                     
                                     <div class="flex-1 overflow-y-auto pr-1 custom-scrollbar">
                                        <div v-if="adminStats.leaderboard.length === 0" class="h-full flex items-center justify-center text-white/20 text-xs">
                                          暂无数据
                                        </div>
                                        <div v-else class="space-y-1.5">
                                           <div v-for="(user, idx) in visibleLeaderboard" :key="user.id" 
                                                class="flex justify-between items-center p-2 rounded-lg bg-black/10 border border-white/5 hover:bg-white/10 transition-colors">
                                              <div class="flex items-center gap-2">
                                                 <div class="w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-black"
                                                      :class="{
                                                        'bg-yellow-400 text-yellow-900': ((leaderboardPage - 1) * 5 + idx) === 0,
                                                        'bg-gray-300 text-gray-900': ((leaderboardPage - 1) * 5 + idx) === 1,
                                                        'bg-orange-400 text-orange-900': ((leaderboardPage - 1) * 5 + idx) === 2,
                                                        'bg-white/10 text-white/50': ((leaderboardPage - 1) * 5 + idx) > 2
                                                      }">
                                                   {{ (leaderboardPage - 1) * 5 + idx + 1 }}
                                                 </div>
                                                 <span class="text-xs font-bold text-white/90 truncate max-w-[80px]">{{ user.email.split('@')[0] }}</span>
                                              </div>
                                              <span class="text-[10px] font-mono text-indigo-300">{{ user.today_used }}</span>
                                           </div>
                                        </div>
                                     </div>
                                  </div>                  </div>
        
                  <!-- Credential & User Management Table Container -->
                  <div class="bg-white/80 backdrop-blur-xl border border-white/20 rounded-[40px] p-1 shadow-2xl overflow-hidden">
                    <!-- Admin Tabs -->
                    <div class="flex gap-2 p-2 border-b border-gray-100/50">
                        <button @click="adminTab = 'credentials'" class="px-6 py-3 rounded-full text-sm font-bold transition-all"
                            :class="adminTab === 'credentials' ? 'bg-indigo-600 text-white shadow-lg' : 'text-white/70 hover:bg-white/10'">
                            🎫 凭证管理
                        </button>
                        <button @click="adminTab = 'users'" class="px-6 py-3 rounded-full text-sm font-bold transition-all"
                            :class="adminTab === 'users' ? 'bg-pink-600 text-white shadow-lg' : 'text-white/70 hover:bg-white/10'">
                            👥 用户管理
                        </button>
                        <button @click="adminTab = 'settings'" class="px-6 py-3 rounded-full text-sm font-bold transition-all"
                            :class="adminTab === 'settings' ? 'bg-teal-600 text-white shadow-lg' : 'text-white/70 hover:bg-white/10'">
                            ⚙️ 系统设置
                        </button>
                    </div>
        
                    <div class="p-4">
                        <AdminCredentialTable v-if="adminTab === 'credentials'" />
                        <AdminUserTable v-if="adminTab === 'users'" />
                        <AdminQuotaSettings v-if="adminTab === 'settings'" />
                    </div>
                  </div>
                </div>
              </div>
      <!-- 2. 贡献 (Contribution) - 放大出现 -->
      <div v-else-if="currentTab === 'upload'" class="max-w-4xl mx-auto space-y-8"
           v-motion
           :initial="{ opacity: 0, scale: 0.9 }"
           :enter="{ opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 250, damping: 20 } }"
      >
        
        <!-- 上传卡片 -->
        <div class="bg-gradient-to-br from-indigo-100 to-purple-100 text-indigo-950 rounded-[40px] p-10 shadow-2xl border border-white/50">
          <h2 class="text-3xl font-black mb-4">添加新凭证</h2>
          <p class="text-lg font-medium opacity-70 mb-6">
            上传 Google Service Account JSON 文件，立即解锁更多额度。若包含 Gemini 3.0 权限，将自动识别并解锁至臻权限。
          </p>

          <div class="relative group">
            <textarea 
              v-model="uploadContent" 
              rows="6" 
              class="w-full bg-white/60 border-2 border-transparent rounded-3xl p-6 text-indigo-950 placeholder-indigo-950/30 focus:border-indigo-400 focus:bg-white focus:outline-none font-mono text-sm resize-none transition-all"
              placeholder='在此粘贴 JSON 内容，或者点击下方上传文件...'
            ></textarea>
            
            <!-- 文件上传遮罩 -->
            <div class="absolute bottom-4 right-4">
               <label class="cursor-pointer bg-white text-indigo-600 px-4 py-2 rounded-full font-bold shadow-md hover:bg-indigo-50 transition flex items-center gap-2">
                 <span>{{ filesToUpload.length > 0 ? `已选 ${filesToUpload.length} 个文件` : '📂 批量上传' }}</span>
                 <input type="file" accept=".json" multiple class="hidden" @change="handleFileUpload">
               </label>
            </div>
          </div>

          <div class="flex items-center justify-end mt-6 gap-4 flex-wrap">
             <a 
               href="https://oauth.beijixingxing.com/" 
               target="_blank"
               class="px-6 py-4 text-white bg-green-500 rounded-full font-bold text-lg hover:bg-green-600 transition-all shadow-lg shadow-green-500/30 flex items-center gap-2"
             >
               🔗 获取凭证 / Get Credential
             </a>

             <button 
               @click="handleCheckRaw" 
               :disabled="isUploading || !uploadContent"
               class="px-6 py-4 text-indigo-600 bg-white border-2 border-indigo-100 rounded-full font-bold text-lg hover:bg-indigo-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
             >
               {{ isCheckingRaw ? '检测中...' : '🔍 仅检测 3.0 资格' }}
             </button>

             <button 
               @click="handleUpload" 
               :disabled="isUploading"
               class="px-10 py-4 bg-indigo-600 text-white rounded-full font-black text-lg hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
             >
               {{ isUploading ? '验证中...' : '验证并提交 ✨' }}
             </button>
          </div>
        </div>

        <!-- 我的凭证列表 -->
        <div class="bg-white/5 border border-white/10 rounded-[40px] p-8">
           <h3 class="text-xl font-bold mb-6">我的上传记录</h3>
           <div v-if="myCredentials.length === 0" class="text-center py-8 text-white/30">
             空空如也，快去上传一个吧！
           </div>
           <div v-else class="space-y-3">
             <div v-for="(cred, index) in visibleCredentials" :key="cred.id" 
                  class="flex items-center justify-between p-4 rounded-2xl transition"
                  :class="cred.status === 'DEAD' ? 'bg-black/20 opacity-70 grayscale' : 'bg-white/5 hover:bg-white/10'"
             >
                <div class="flex items-center gap-4">
                  <div class="w-10 h-10 rounded-full flex items-center justify-center text-xl bg-white/10">
                    {{ cred.status === 'ACTIVE' ? '🟢' : (cred.status === 'DEAD' ? '🚫' : '🔴') }}
                  </div>
                  <div>
                    <div class="font-bold flex items-center gap-2">
                        <span>凭证 #{{ index + 1 }}</span>
                        <span v-if="cred.status === 'DEAD'" class="text-[10px] bg-red-500/20 text-red-300 px-2 py-0.5 rounded">已失效</span>
                        <span v-if="cred.supports_v3" class="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded border border-purple-500/30">Gemini 3.0</span>
                    </div>
                    <div class="text-xs opacity-50">{{ new Date(cred.created_at).toLocaleDateString() }}</div>
                  </div>
                </div>
                
                <div class="flex items-center gap-2">
                    <button @click="deleteCredential(cred.id)" class="text-sm text-red-300 hover:text-red-100 px-3 py-1 rounded-lg hover:bg-red-500/20 transition">
                    {{ cred.status === 'DEAD' ? '移除' : '删除' }}
                    </button>
                </div>
             </div>
             
             <div v-if="myCredentials.length > visibleLimit" class="text-center mt-4">
                 <button @click="visibleLimit += 5" class="text-sm text-white/50 hover:text-white transition">
                     显示更多 ({{ myCredentials.length - visibleLimit }}) ↓
                 </button>
             </div>
           </div>
        </div>
      </div>

      <!-- 3. 密钥 (API Keys) - 从右侧滑入 -->
      <div v-else-if="currentTab === 'keys'" class="max-w-4xl mx-auto"
           v-motion
           :initial="{ opacity: 0, x: 100 }"
           :enter="{ opacity: 1, x: 0, transition: { type: 'spring', stiffness: 200, damping: 20 } }"
      >
        <div class="flex justify-between items-center mb-8">
          <h2 class="text-3xl font-bold">API 密钥管理</h2>
          <button @click="openCreateKeyModal" class="px-6 py-3 bg-teal-400 text-teal-950 rounded-full font-black hover:bg-teal-300 transition-colors shadow-lg shadow-teal-400/20">
            + 新建密钥
          </button>
        </div>

        <div class="grid gap-4">
          <div v-for="k in apiKeys" :key="k.id" 
               class="bg-white/10 border border-white/10 rounded-3xl p-6 flex flex-col md:flex-row justify-between items-start md:items-center hover:scale-[1.01] transition-transform duration-200 gap-4"
               :class="{ 'opacity-60': !k.is_active }"
          >
            <div class="flex flex-col">
              <div class="flex items-center gap-3 mb-1">
                  <span class="font-bold text-lg">{{ k.name || '未命名密钥' }}</span>
                  <span v-if="k.type === 'ADMIN'" class="bg-yellow-500/20 text-yellow-300 text-[10px] font-black px-2 py-0.5 rounded uppercase border border-yellow-500/30">Admin Key</span>
                  <span v-if="!k.is_active" class="bg-red-500/20 text-red-300 text-[10px] font-black px-2 py-0.5 rounded uppercase border border-red-500/30">Disabled</span>
              </div>
              <code class="text-sm font-mono text-teal-200/80 bg-black/20 px-2 py-1 rounded break-all">{{ k.key }}</code>
              <span class="text-xs text-white/30 mt-2">创建于 {{ new Date(k.created_at).toLocaleDateString() }}</span>
            </div>
            
            <div class="flex items-center gap-3 self-end md:self-center">
                <button 
                    @click="toggleKey(k)"
                    class="px-4 py-2 rounded-xl text-xs font-bold transition-colors"
                    :class="k.is_active ? 'bg-white/10 hover:bg-yellow-500/20 text-white' : 'bg-green-500/20 text-green-300 hover:bg-green-500/30'"
                >
                    {{ k.is_active ? '禁用' : '启用' }}
                </button>
                <button @click="openRenameKeyModal(k)" class="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold transition-colors">
                    重命名
                </button>
                <button @click="deleteKey(k.id)" class="w-10 h-10 rounded-xl bg-white/5 hover:bg-red-500/20 text-white/50 hover:text-red-300 flex items-center justify-center font-bold transition">
                  ✕
                </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. 反重力渠道 (Antigravity) -->
      <div v-else-if="currentTab === 'antigravity'" class="max-w-5xl mx-auto"
           v-motion
           :initial="{ opacity: 0, y: 30 }"
           :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 20 } }"
      >
        <AntigravityView :isAdmin="isAdmin" />
      </div>

      <!-- Modals -->
      <!-- Create Key Modal -->
      <div v-if="showCreateModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-gray-900 border border-white/10 p-8 rounded-3xl w-full max-w-md shadow-2xl" v-motion-pop>
              <h3 class="text-2xl font-bold mb-6">创建新密钥</h3>
              <input v-model="newKeyName" placeholder="给密钥起个名字 (例如: Bob's App)" class="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 mb-4 text-white focus:outline-none focus:border-teal-500 transition-colors">
              
              <div v-if="isAdmin" class="mb-6 flex items-center gap-3">
                  <input type="checkbox" id="adminKey" v-model="newKeyIsAdmin" class="w-5 h-5 rounded bg-black/30 border-white/10 text-teal-500 focus:ring-teal-500">
                  <label for="adminKey" class="text-sm text-gray-300">这是管理员密钥 (无限额度)</label>
              </div>

              <div class="flex justify-end gap-3">
                  <button @click="showCreateModal = false" class="px-6 py-2 rounded-xl hover:bg-white/10 transition-colors">取消</button>
                  <button @click="confirmCreateKey" class="px-6 py-2 bg-teal-500 text-black font-bold rounded-xl hover:bg-teal-400 transition-colors">创建</button>
              </div>
          </div>
      </div>

      <!-- Rename Key Modal -->
      <div v-if="showRenameModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-gray-900 border border-white/10 p-8 rounded-3xl w-full max-w-md shadow-2xl" v-motion-pop>
              <h3 class="text-2xl font-bold mb-6">重命名密钥</h3>
              <input v-model="renameValue" class="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 mb-6 text-white focus:outline-none focus:border-teal-500 transition-colors">
              
              <div class="flex justify-end gap-3">
                  <button @click="showRenameModal = false" class="px-6 py-2 rounded-xl hover:bg-white/10 transition-colors">取消</button>
                  <button @click="confirmRenameKey" class="px-6 py-2 bg-indigo-500 text-white font-bold rounded-xl hover:bg-indigo-400 transition-colors">保存</button>
              </div>
          </div>
      </div>

      <AnnouncementModal 
        :show="showAnnouncement" 
        :content="announcementData.content" 
        :force-read="forceReadAnnouncement"
        @close="closeAnnouncement"
      />

    </main>

    <!-- 手机端底部导航栏 (Mobile Bottom Nav) -->
    <div class="md:hidden fixed bottom-0 left-0 w-full bg-black/40 backdrop-blur-xl border-t border-white/10 z-50 flex justify-around items-center pb-safe safe-area-inset-bottom">
      <button @click="currentTab = 'home'" :class="mobileTabClass('home')">
        <span class="text-xl mb-1">🏠</span>
        <span class="text-[10px] font-bold">概览</span>
      </button>
      <button @click="currentTab = 'antigravity'" :class="mobileAntigravityClass">
        <span class="text-xl mb-1">🚀</span>
        <span class="text-[10px] font-bold">反重力</span>
      </button>
      <button @click="currentTab = 'upload'" :class="mobileTabClass('upload')">
        <span class="text-xl mb-1">🎁</span>
        <span class="text-[10px] font-bold">上传</span>
      </button>
      <button @click="currentTab = 'keys'" :class="mobileTabClass('keys')">
        <span class="text-xl mb-1">🔑</span>
        <span class="text-[10px] font-bold">密钥</span>
      </button>
    </div>
    <!-- Change Password Modal -->
    <div v-if="showChangePwModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-gray-900 border border-white/10 p-8 rounded-3xl w-full max-w-sm shadow-2xl" v-motion-pop>
            <h3 class="text-xl font-bold mb-6 text-white">🔒 修改密码</h3>
            <div class="space-y-4">
                <div>
                    <label class="text-xs text-white/50 mb-1 block">旧密码</label>
                    <input type="password" v-model="pwOld" class="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-pink-500 outline-none transition">
                </div>
                <div>
                    <label class="text-xs text-white/50 mb-1 block">新密码 (至少6位)</label>
                    <input type="password" v-model="pwNew" class="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white focus:border-pink-500 outline-none transition">
                </div>
            </div>
            <div class="flex justify-end gap-3 mt-8">
                <button @click="showChangePwModal = false" class="px-5 py-2 rounded-xl hover:bg-white/10 text-sm text-white/70">取消</button>
                <button @click="changePassword" class="px-5 py-2 bg-pink-600 hover:bg-pink-500 text-white rounded-xl font-bold text-sm">修改</button>
            </div>
        </div>
    </div>

    <div v-if="showForceDiscordModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white p-8 rounded-3xl w-full max-w-md shadow-2xl">
            <h3 class="text-xl font-bold mb-3 text-gray-800">为保证公益站资源有效利用</h3>
            <p class="text-sm text-gray-600 mb-6">
                我们需要您同意并授权 Discord。我们仅会收取您的 Discord 名称、头像和数字ID，不会记录其他数据。
                点击同意并授权将跳转至 Discord 授权，授权后绑定您的个人信息。未确认无法使用任何功能。
            </p>
            <div class="flex gap-3">
                <button @click="bindDiscord" class="flex-1 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold">同意并授权</button>
                <button @click="logout" class="px-5 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-xl font-bold">退出登录</button>
            </div>
        </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '@/utils/api'; 
import AnimatedBackground from '../components/AnimatedBackground.vue';
import AdminCredentialTable from '../components/AdminCredentialTable.vue';
import AdminUserTable from '../components/AdminUserTable.vue';
import AdminQuotaSettings from '../components/AdminQuotaSettings.vue';
import AdminSettings from '../components/AdminSettings.vue';
import GaugeChart from '../components/GaugeChart.vue';
import AnnouncementModal from '../components/AnnouncementModal.vue';
import AntigravityView from '../components/AntigravityView.vue';

const router = useRouter();
const route = useRoute();
const currentTab = ref('home');
const adminTab = ref('credentials');
const uploadContent = ref('');
const isUploading = ref(false);
const isCheckingRaw = ref(false);
const visibleLimit = ref(5);
const filesToUpload = ref<File[]>([]);

const handleFileUpload = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
        filesToUpload.value = Array.from(target.files);
        // Optional: Preview the first file in the text area for UX
        const reader = new FileReader();
        reader.onload = (e) => {
            uploadContent.value = (e.target?.result as string) || '';
        };
        reader.readAsText(target.files[0]);
    }
};

const handleCheckRaw = async () => {
    if (!uploadContent.value) return;
    isCheckingRaw.value = true;
    try {
        const res = await api.post('/credentials/check-raw', { json_content: uploadContent.value });
        const data = res.data;
        
        if (data.success) {
            if (data.supports_v3) {
                alert('🎉 恭喜！此凭证拥有 Gemini 3.0 (Preview) 权限！\n建议立即上传以解锁最高额度。');
            } else {
                let msg = '💨 此凭证有效，但暂未开放 Gemini 3.0 权限。\n(仅可使用 Gemini 2.5 系列模型)';
                if (data.error) {
                    msg += '\n\n详细原因: ' + data.error;
                }
                alert(msg);
            }
        } else {
            alert('检测失败: ' + data.error);
        }
    } catch (e: any) {
        alert('检测出错: ' + (e.response?.data?.error || e.message));
    } finally {
        isCheckingRaw.value = false;
    }
};

const handleUpload = async () => {
    if (filesToUpload.value.length === 0 && !uploadContent.value) return;
    
    isUploading.value = true;
    let successCount = 0;
    let failCount = 0;

    // 1. If files are selected, upload them one by one
    if (filesToUpload.value.length > 0) {
        for (const file of filesToUpload.value) {
            try {
                const content = await file.text();
                await api.post('/credentials', { 
                    json_content: content
                });
                successCount++;
            } catch (e) {
                console.error(`Failed to upload ${file.name}`, e);
                failCount++;
            }
        }
    } 
    // 2. If no files but text content exists (paste mode)
    else if (uploadContent.value) {
        try {
            await api.post('/credentials', { 
                json_content: uploadContent.value
            });
            successCount++;
        } catch (e) {
            failCount++;
        }
    }

    isUploading.value = false;
    alert(`上传完成: 成功 ${successCount} 个, 失败 ${failCount} 个`);
    
    // Reset
    uploadContent.value = '';
    filesToUpload.value = [];
    // Clear file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    if(fileInput) fileInput.value = '';
    
    // Refresh
    fetchStats();
};

// Announcement State
const showAnnouncement = ref(false);
const announcementData = ref({ content: '', version: 0 });
const forceReadAnnouncement = ref(false);

const stats = ref({ 
    level: 0, 
    daily_limit: 300, 
    today_used: 0, 
    model_usage: { 'gemini-2.5-flash': 0, 'gemini-2.5-pro': 0, 'gemini-3-pro-preview': 0 },
    antigravity_usage: { claude: 0, gemini3: 0, limits: { claude: 100, gemini3: 200 } },
    contributed_active: 0, 
    contributed_v3_active: 0, 
    system_config: { quota: { contributor: 1500 } } 
});

const userInfo = ref<any>({});
const apiKeys = ref<any[]>([]);
const myCredentials = ref<any[]>([]);
const isAdmin = ref(false);
const adminStats = ref({
  overview: {
    active_credentials: 0,
    dead_credentials: 0,
    total_credentials: 0,
    global_capacity: 0,
    global_usage: 0,
    capacities: { flash: 0, pro: 0, v3: 0 },
    model_usage: { flash: 0, pro: 0, v3: 0 },
    utilization_rate: 0
  },
  leaderboard: [] as any[]
});

// Key Management State
const showCreateModal = ref(false);
const showRenameModal = ref(false);
const showChangePwModal = ref(false);
const newKeyName = ref('');
const newKeyIsAdmin = ref(false);
const renameValue = ref('');
const targetKey = ref<any>(null);

// Password Change State
const pwOld = ref('');
const pwNew = ref('');

const leaderboardPage = ref(1);

const visibleCredentials = computed(() => {
    return myCredentials.value.slice(0, visibleLimit.value);
});

const visibleLeaderboard = computed(() => {
    const list = adminStats.value?.leaderboard;
    if (!Array.isArray(list)) return [];
    const start = (leaderboardPage.value - 1) * 5;
    return list.slice(start, start + 5);
});

// ... computed properties ...

const userTitle = computed(() => {
    if (stats.value.contributed_v3_active > 0) return '至臻大佬 💎';
    if (stats.value.level > 0 || stats.value.contributed_active > 0) return '大佬 👑';
    return '萌新 🌱';
});

const welcomeMessage = computed(() => {
    if (stats.value.contributed_v3_active > 0) return '尊贵的 Gemini 3.0 贡献者，您已解锁最高权限！';
    if (stats.value.level > 0 || stats.value.contributed_active > 0) return '感谢您的无私奉献，您拥有尊贵的加成额度。';
    const quota = stats.value.system_config?.quota?.contributor || 1500;
    return `还没有上传凭证哦，上传一个即可解锁 ${quota} 次/天！`;
});

const pageTitle = computed(() => {
  switch(currentTab.value) {
    case 'home': return '控制台';
    case 'upload': return '上传中心';
    case 'keys': return '访问密钥';
    case 'antigravity': return '反重力渠道';
    default: return 'Dashboard';
  }
});

const showForceDiscordModal = computed(() => {
    const force = stats.value?.force_discord_bind === true;
    const bound = !!stats.value?.discordId;
    const isAdminUser = stats.value?.role === 'ADMIN';
    return force && !isAdminUser && !bound;
});
const tabClass = (tab: string) => {
  const base = "flex items-center gap-4 px-6 py-4 rounded-full font-bold transition-all w-full hover-wiggle ";
  if (currentTab.value === tab) {
    return base + "bg-white text-black shadow-lg shadow-white/10 scale-105";
  }
  return base + "text-white/60 hover:text-white hover:bg-white/10";
};

const mobileTabClass = (tab: string) => {
  const base = "flex flex-col items-center justify-center w-full py-3 transition-all ";
  if (currentTab.value === tab) {
    return base + "text-white bg-white/10";
  }
  return base + "text-white/40 hover:text-white";
};

const antigravityTabClass = computed(() => {
  const base = "flex items-center gap-4 px-6 py-4 rounded-full font-bold transition-all w-full hover-wiggle ";
  if (currentTab.value === 'antigravity') {
    return base + "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg shadow-purple-500/30 scale-105";
  }
  return base + "text-purple-300/70 hover:text-purple-200 hover:bg-purple-500/10";
});

const mobileAntigravityClass = computed(() => {
  const base = "flex flex-col items-center justify-center w-full py-3 transition-all ";
  if (currentTab.value === 'antigravity') {
    return base + "text-purple-300 bg-purple-500/20";
  }
  return base + "text-purple-400/50 hover:text-purple-300";
});

// ...

// --- Logic ---
const checkAnnouncement = async () => {
    try {
        const res = await api.get('/announcement');
        if (res.data.content) {
            announcementData.value = res.data;
            const localVersion = Number(localStorage.getItem('last_seen_announcement_version') || 0);
            
            // If server version is newer than local version, FORCE SHOW
            if (res.data.version > localVersion) {
                forceReadAnnouncement.value = true;
                showAnnouncement.value = true;
            }
        }
    } catch (e) {
        console.error('Failed to fetch announcement', e);
    }
};

const closeAnnouncement = () => {
    showAnnouncement.value = false;
    // Update local version on close
    localStorage.setItem('last_seen_announcement_version', String(announcementData.value.version));
};

const openAnnouncementPreview = () => {
    forceReadAnnouncement.value = false; // Voluntary view, no timer needed
    showAnnouncement.value = true;
};

const fetchStats = async () => {
  try {
    const res = await api.get('/dashboard/stats');
    stats.value = res.data;
    userInfo.value = res.data;
    
    if(res.data.role === 'ADMIN') {
        isAdmin.value = true;
        const resAdmin = await api.get('/admin/stats');
        adminStats.value = resAdmin.data;
        try {
            const ag = await api.get('/antigravity/stats');
            // Merge a minimal AG usage widget into adminStats.overview without impacting Cloud Code stats
            adminStats.value.overview = {
                ...adminStats.value.overview,
                ag_usage: ag.data.global_usage || { claude: 0, gemini3: 0 },
                ag_total: ag.data.global_usage || { claude: 0, gemini3: 0 }
            };
        } catch {}
    }

    const resKeys = await api.get('/dashboard/api-keys');
    apiKeys.value = resKeys.data;

    const resCreds = await api.get('/credentials');
    myCredentials.value = resCreds.data;

  } catch(e: any) {
      if(e.response?.status === 401) router.push('/login');
  }
};

const changePassword = async () => {
    if(pwNew.value.length < 6) return alert('密码过短');
    try {
        await api.post('/auth/change-password', { oldPassword: pwOld.value, newPassword: pwNew.value });
        alert('密码修改成功');
        showChangePwModal.value = false;
        pwOld.value = '';
        pwNew.value = '';
    } catch(e: any) {
        alert('修改失败: ' + (e.response?.data?.error || '未知错误'));
    }
}

const logout = () => {
    sessionStorage.removeItem('token');
    localStorage.removeItem('token');
    router.push('/login');
};

const bindDiscord = async () => {
    try {
        const res = await api.get('/auth/discord/url', { params: { mode: 'bind' } });
        const url = res.data?.url;
        if (!url) throw new Error('Discord OAuth 未配置');
        window.location.href = url;
    } catch (e: any) {
        alert(e.response?.data?.error || e.message);
    }
};

const bindDiscordApp = async () => {
    try {
        const res = await api.get('/auth/discord/url', { params: { mode: 'bind' } });
        const url = res.data?.url;
        if (!url) throw new Error('Discord OAuth 未配置');
        const ua = navigator.userAgent.toLowerCase();
        const isAndroid = ua.includes('android');
        if (isAndroid) {
            const noSchema = url.replace(/^https?:\/\//, '');
            const intent = `intent://${noSchema}#Intent;scheme=https;package=com.discord;S.browser_fallback_url=${encodeURIComponent(url)};end`;
            location.href = intent;
            setTimeout(() => { location.href = url; }, 1200);
        } else {
            location.href = url;
        }
    } catch (e: any) {
        alert(e.response?.data?.error || e.message);
    }
};
// --- Key Management Logic ---
const openCreateKeyModal = () => {
    newKeyName.value = '';
    newKeyIsAdmin.value = false;
    showCreateModal.value = true;
};

const confirmCreateKey = async () => {
    try {
        await api.post('/dashboard/api-keys', { 
            name: newKeyName.value,
            type: newKeyIsAdmin.value ? 'ADMIN' : 'NORMAL'
        });
        showCreateModal.value = false;
        fetchStats(); // Refresh list
    } catch (e: any) {
        alert('创建失败: ' + (e.response?.data?.error || e.message));
    }
};

const toggleKey = async (key: any) => {
    try {
        await api.patch(`/dashboard/api-keys/${key.id}`, { is_active: !key.is_active });
        fetchStats();
    } catch (e) {
        alert('操作失败');
    }
};

const deleteKey = async (id: number) => {
    if(!confirm('确定删除此密钥？')) return;
    try {
        await api.delete(`/dashboard/api-keys/${id}`);
        fetchStats();
    } catch (e) {
        alert('删除失败');
    }
};

const openRenameKeyModal = (key: any) => {
    targetKey.value = key;
    renameValue.value = key.name || '';
    showRenameModal.value = true;
};

const confirmRenameKey = async () => {
    if (!targetKey.value) return;
    try {
        await api.patch(`/dashboard/api-keys/${targetKey.value.id}`, { name: renameValue.value });
        showRenameModal.value = false;
        fetchStats();
    } catch (e) {
        alert('重命名失败');
    }
};

const deleteCredential = async (id: number) => {
    if(!confirm('确定删除此凭证？')) return;
    try {
        await api.delete(`/credentials/${id}`);
        fetchStats();
    } catch(e) {
        alert('删除失败');
    }
};

// ... existing functions ...

onMounted(() => {
    fetchStats();
    checkAnnouncement();
});
</script>

<style>
/* iPhone 底部安全区适配 */
.pb-safe {
  padding-bottom: 20px;
}

/* 自定义滚动条 */
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
