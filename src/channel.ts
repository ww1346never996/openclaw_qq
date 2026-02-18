import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";
import * as path from "node:path";

const WORKSPACE_IMG_DIR = "/home/admin/.openclaw/workspace/tmp_images";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

// 👇 新增：消息缓冲池接口和全局 Map
interface MessageBuffer {
    timer: NodeJS.Timeout;
    texts: string[];
    mediaUrls: string[];
    lastEvent: any; // 保留最后一次的事件，用于获取发送者状态
}
const messageBufferPool = new Map<string, MessageBuffer>();
// 缓冲等待时间（毫秒）
const DEBOUNCE_WAIT_MS = 5000;

const memberCache = new Map<string, { name: string, time: number }>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

function getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
}

// 👇 将这个函数替换为这个“静音版”
async function extractImageUrls(
  message: OneBotMessage | string | undefined,
  client: OneBotClient,
  maxImages = 3
): Promise<string[]> {
  // 彻底掐断底层框架自动转 Base64 的原生通道！
  // 所有的视觉任务现在全部交由正文注入的路径和 AGENTS.md 里的 Python 脚本接管
  return []; 
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  let result = text;
  const imageUrls: string[] = [];
  
  // Match both url= and file= if they look like URLs
  const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) {
      imageUrls.push(val);
    }
  }

  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    if (match.startsWith("[CQ:image")) {
      return "[图片]";
    }
    // 👇 新增这三行，给语音放行
    if (match.startsWith("[CQ:record")) {
      return match;
    }
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) {
          return id;
        }
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();

function getClientForAccount(accountId: string) {
    return clients.get(accountId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
        .replace(/\*(.*?)\*/g, "$1")     // Italic
        .replace(/`(.*?)`/g, "$1")       // Inline code
        .replace(/#+\s+(.*)/g, "$1")     // Headers
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
        .replace(/^\s*>\s+(.*)/gm, "▎$1") // Blockquotes
        .replace(/```[\s\S]*?```/g, "[代码块]") // Code blocks
        .replace(/^\|.*\|$/gm, (match) => { // Simple table row approximation
             return match.replace(/\|/g, " ").trim();
        })
        .replace(/^[\-\*]\s+/gm, "• "); // Lists
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const path = fileURLToPath(url);
            const data = await fs.readFile(path);
            const base64 = data.toString("base64");
            return `base64://${base64}`;
        } catch (e) {
            console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
            return url; // Fallback to original
        }
    }
    return url;
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  type: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) {
              return [];
          }
      },
      listGroups: async ({ accountId, cfg }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}

          // @ts-ignore
          const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
          if (enableGuilds) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      type: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };
          
          const client = new OneBotClient({
              wsUrl: account.config.wsUrl,
              accessToken: account.config.accessToken,
          });
          
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);

              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ 
                          ok: true, 
                          bot: { id: String(info.user_id), username: info.nickname } 
                      });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });

              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => {
          return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
          };
      }
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => 
        applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: ({ input }) => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({
            cfg,
            channelKey: "qq",
            accountId,
            name: input.name,
        });
        
        const next = accountId !== DEFAULT_ACCOUNT_ID 
            ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) 
            : namedConfig;

        const newConfig = {
            wsUrl: input.wsUrl || "ws://localhost:3001",
            accessToken: input.accessToken,
            enabled: true,
        };

        if (accountId === DEFAULT_ACCOUNT_ID) {
            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: { ...next.channels?.qq, ...newConfig }
                }
            };
        }
        
        return {
            ...next,
            channels: {
                ...next.channels,
                qq: {
                    ...next.channels?.qq,
                    enabled: true,
                    accounts: {
                        ...next.channels?.qq?.accounts,
                        [accountId]: {
                            ...next.channels?.qq?.accounts?.[accountId],
                            ...newConfig
                        }
                    }
                }
            }
        };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        // 1. Prevent multiple clients for the same account
        const existingClient = clients.get(account.accountId);
        if (existingClient) {
            console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
            existingClient.disconnect();
        }

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        const processedMsgIds = new Set<string>();
        const cleanupInterval = setInterval(() => {
            if (processedMsgIds.size > 1000) processedMsgIds.clear();
        }, 3600000);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.user_id) client.setSelfId(info.user_id);
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
             } catch (err) { }
        });

        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
          try {
            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                 return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                if (String(event.target_id) === String(client.getSelfId())) {
                    event.post_type = "message";
                    event.message_type = event.group_id ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                } else return;
            }

            if (event.post_type !== "message") return;

            console.log(`[QQ] message: type=${event.message_type}, hasImage=${Array.isArray(event.message) && event.message.some((s: any) => s.type === "image")}`);
            console.log(`[QQ] extractImageUrls: processing message, extracting image URLs...`);

            // 2. Dynamic self-message filtering
            const selfId = client.getSelfId() || event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) return;

            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) return;
                processedMsgIds.add(msgIdKey);
            }

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            
            if (isGuild && !config.enableGuilds) return;

            const userId = event.user_id;
            const groupId = event.group_id;
            const guildId = event.guild_id;
            const channelId = event.channel_id;
            
            let text = event.raw_message || "";
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                            else {
                                try {
                                    const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name });
                                    name = info?.card || info?.nickname || name;
                                    setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                } catch (e) {}
                            }
                        }
                        resolvedText += ` @${name} `;
                    }else if (seg.type === "record") {
                        // 提取真实的 url 并拼接成完整的 CQ 码，喂给大模型
                        const recordUrl = seg.data?.url || "";
                        const recordFile = seg.data?.file || "";
                        resolvedText += ` [CQ:record,file=${recordFile},url=${recordUrl}]`;
                    }
                    else if (seg.type === "image") {
                        let safePath = "";
                        if (seg.data?.file) {
                             try {
                                 // 获取原图绝对路径 (加上 original: true 保证高清)
                                 const imgInfo = await (client as any).sendWithResponse("get_image", { file: seg.data.file, original: true });
                                 if (imgInfo && imgInfo.file) {
                                     const originalPath = imgInfo.file;
                                     const pathModule = await import("node:path");
                                     const fsModule = await import("node:fs/promises");
                                     
                                     // 提取扩展名并重命名
                                     const ext = pathModule.extname(originalPath) || '.jpg';
                                     const newFileName = `qq_img_${Date.now()}${ext}`;
                                     safePath = pathModule.join(WORKSPACE_IMG_DIR, newFileName);
                                     
                                     // 确保沙箱目录存在，并把图片复制进去
                                     await fsModule.mkdir(WORKSPACE_IMG_DIR, { recursive: true });
                                     await fsModule.copyFile(originalPath, safePath);
                                     console.log(`[QQ] 成功将图片转存至沙箱白名单: ${safePath}`);
                                 }
                             } catch(e) {
                                 console.warn(`[QQ] 图片转存失败: ${e}`);
                             }
                        }
                        if (safePath) {
                             resolvedText += `\n[图片已存入工作区: ${safePath}]\n`;
                        } else {
                             resolvedText += " [图片]";
                        }
                    }
                    else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         if (!seg.data?.url && isGroup) {
                             try {
                                 const info = await (client as any).sendWithResponse("get_group_file_url", { group_id: groupId, file_id: seg.data?.file_id, busid: seg.data?.busid });
                                 if (info?.url) seg.data.url = info.url;
                             } catch(e) {}
                         }
                         resolvedText += ` [文件: ${seg.data?.file || "未命名"}]`;
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (config.blockedUsers?.includes(userId)) return;
            if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId)) return;
            
            const isAdmin = config.admins?.includes(userId) ?? false;
            if (config.admins?.length && !isAdmin) return;

            if (!isGuild && isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            let historyContext = "";
            if (isGroup && config.historyLimit !== 0) {
                 try {
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history?.messages) {
                         const limit = config.historyLimit || 5;
                         historyContext = history.messages.slice(-(limit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");
            if (!isTriggered && config.keywordTriggers) {
                for (const kw of config.keywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }
            
            const checkMention = isGroup || isGuild;
            if (checkMention && config.requireMention && !isTriggered) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) return;
                let mentioned = false;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) { mentioned = true; break; } }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) mentioned = true;
                if (!mentioned && repliedMsg?.sender?.user_id === effectiveSelfId) mentioned = true;
                if (!mentioned) return;
            }

            let fromId = String(userId);
            let conversationLabel = `QQ User ${userId}`;
            if (isGroup) {
                fromId = `group:${groupId}`;
                conversationLabel = `QQ Group ${groupId}`;
            } else if (isGuild) {
                fromId = `guild:${guildId}:${channelId}`;
                conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
            }

            const runtime = getQQRuntime();

            const deliver = async (payload: ReplyPayload) => {
                 const send = async (msg: string) => {
                     let processed = msg;

                     // ==========================================
                     // 👇 补漏：在这里拦截并替换表情短码！
                     // ==========================================
                     processed = processed.replace(/\{表情:([a-zA-Z0-9_]+)\}/g, "[CQ:image,file=file:///home/admin/.openclaw/workspace/assets/stickers/saki_$1.png]");
                     
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         
                         if (isGroup) client.sendGroupMsg(groupId, chunk);
                         else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, chunk);
                         else client.sendPrivateMsg(userId, chunk);
                         
                         if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                             const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                             if (tts) { 
                                 if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`); 
                                 else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`); 
                             }
                         }
                         
                         if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                     }
                 };
                 if (payload.text) await send(payload.text);
                 if (payload.files) {
                     for (const f of payload.files) { 
                         if (f.url) { 
                             const url = await resolveMediaUrl(f.url);
                             if (isImageFile(url)) {
                                 const imgMsg = `[CQ:image,file=${url}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, imgMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, imgMsg);
                                 else client.sendPrivateMsg(userId, imgMsg);
                             } else {
                                 const txtMsg = `[CQ:file,file=${url},name=${f.name || 'file'}]`;
                                 if (isGroup) client.sendGroupMsg(groupId, txtMsg);
                                 else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, `[文件] ${url}`);
                                 else client.sendPrivateMsg(userId, txtMsg);
                             }
                             if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                         } 
                     }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            // 1. 获取基础文本和引用的消息
            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            
            // 👇 修改点 1：只保留用户的纯净发言，绝对不要在这里加 <system> 标签！
            const pureUserText = cleanCQCodes(text) + replySuffix; 

            // 2. 获取图片 URL
            const mediaUrls = await extractImageUrls(event.message, client);
            
            // ==========================================
            // 👇 核心改造：消息缓冲池防抖逻辑开始
            // ==========================================
            const bufferKey = `qq:${fromId}`;

            // 清除旧的发送倒计时
            if (messageBufferPool.has(bufferKey)) {
                clearTimeout(messageBufferPool.get(bufferKey)!.timer);
            }

            // 获取或初始化这个会话的篮子
            const currentBuffer = messageBufferPool.get(bufferKey) || {
                timer: null as any,
                texts: [],
                mediaUrls: [],
                lastEvent: null
            };

            // 👇 修改点 2：把纯净无污染的文本推入篮子
            currentBuffer.texts.push(pureUserText);
            currentBuffer.mediaUrls.push(...mediaUrls);
            currentBuffer.lastEvent = event; 

            // 设置倒计时
            currentBuffer.timer = setTimeout(async () => {
                // 倒计时结束，取出篮子
                const finalBuffer = messageBufferPool.get(bufferKey);
                if (!finalBuffer) return;
                messageBufferPool.delete(bufferKey); 

                const finalEvent = finalBuffer.lastEvent;

                // 👇 修改点 3：在最终冲刷时，全局只拼接一次系统提示词和历史记录
                let systemBlock = "";
                if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
                if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;

                // 将多句话合并，并在最顶部统一加上系统上下文
                const combinedBody = systemBlock + finalBuffer.texts.join("\n\n");
                const combinedMediaUrls = [...new Set(finalBuffer.mediaUrls)];

                console.log(`[QQ] 冲刷缓冲池: ${bufferKey}, 合并了 ${finalBuffer.texts.length} 条消息`);

                // 组装合并后的 Payload 交给大脑
                const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                    Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", 
                    Body: combinedBody, 
                    RawBody: finalEvent.raw_message, 
                    SenderId: String(userId), SenderName: finalEvent.sender?.nickname || "Unknown", ConversationLabel: conversationLabel,
                    SessionKey: bufferKey, AccountId: account.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: finalEvent.time * 1000,
                    OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                    ...(combinedMediaUrls.length > 0 && { MediaUrls: combinedMediaUrls }), 
                    ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
                });
                
                // 记录上下文与触发回答
                await runtime.channel.session.recordInboundSession({
                    storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                    sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                    updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
                    onRecordError: (err) => console.error("QQ Session Error:", err)
                });

                try { 
                    await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
                } catch (error) { 
                    if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); 
                }
            }, DEBOUNCE_WAIT_MS);

            // 保存篮子状态
            messageBufferPool.set(bufferKey, currentBuffer);
            // ==========================================
            // 👆 缓冲池逻辑结束
            // ==========================================

          } catch (err) {
            console.error("[QQ] Critical error in message handler:", err);
          }
        });

        client.connect();
        return () => { 
            clearInterval(cleanupInterval);
            client.disconnect(); 
            clients.delete(account.accountId); 
        };
    },
    logoutAccount: async ({ accountId, cfg }) => {
        return { loggedOut: true, cleared: true };
    }
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        
        // ==========================================
        // 👇 核心绝杀：正则拦截大模型的短码，替换为绝对路径
        // ==========================================
        let finalOutput = text.replace(/\{表情:([a-zA-Z0-9_]+)\}/g, "[CQ:image,file=file:///home/admin/.openclaw/workspace/assets/stickers/saki_$1.png]");

        // 下面把原来的 text 换成 finalOutput
        const chunks = splitMessage(finalOutput, 4000);
        for (let i = 0; i < chunks.length; i++) {
            let message: OneBotMessage | string = chunks[i];
            if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
            
            if (to.startsWith("group:")) client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
            else if (to.startsWith("guild:")) {
                const parts = to.split(":");
                if (parts.length >= 3) client.sendGuildChannelMsg(parts[1], parts[2], message);
            }
            else client.sendPrivateMsg(parseInt(to, 10), message);
            
            if (chunks.length > 1) await sleep(1000); 
        }
        return { channel: "qq", sent: true };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
         
         const finalUrl = await resolveMediaUrl(mediaUrl);
         
         const message: OneBotMessage = [];
         if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
         if (text) message.push({ type: "text", data: { text } });
         if (isImageFile(mediaUrl)) message.push({ type: "image", data: { file: finalUrl } });
         else message.push({ type: "text", data: { text: `[CQ:file,file=${finalUrl},url=${finalUrl}]` } });
         
         if (to.startsWith("group:")) client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
         else if (to.startsWith("guild:")) {
             const parts = to.split(":");
             if (parts.length >= 3) client.sendGuildChannelMsg(parts[1], parts[2], message);
         }
         else client.sendPrivateMsg(parseInt(to, 10), message);
         return { channel: "qq", sent: true };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: { 
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^guild:/.test(id),
          hint: "QQ号, 群号 (group:123), 或频道 (guild:id:channel)",
      }
  },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};