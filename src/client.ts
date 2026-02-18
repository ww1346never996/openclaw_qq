import WebSocket from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./types.js";

interface OneBotClientOptions {
  wsUrl: string;
  accessToken?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000; // Max 1 minute delay
  private selfId: number | null = null;
  private isAlive = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  
  // 👇 新增：离线消息发送队列
  private outQueue: string[] = [];

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  setSelfId(id: number) {
    this.selfId = id;
  }

  connect() {
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    try {
      this.ws = new WebSocket(this.options.wsUrl, { headers });

      this.ws.on("open", () => {
        this.isAlive = true;
        this.reconnectAttempts = 0; // Reset counter on success
        this.emit("connect");
        console.log("[QQ] Connected to OneBot server");
        
        // 👇 新增：一旦重连成功，立刻将积压在队列里（被断网憋住）的消息发出去！
        if (this.outQueue.length > 0) {
            console.log(`[QQ] Flushing ${this.outQueue.length} queued outbound messages...`);
            while (this.outQueue.length > 0) {
                const msg = this.outQueue.shift();
                if (msg) this.ws?.send(msg);
            }
        }

        // Start heartbeat check
        this.startHeartbeat();
      });

      // 👇 新增：监听原生的 Pong 响应，确保连接绝对健康
      this.ws.on("pong", () => {
        this.isAlive = true;
      });

      this.ws.on("message", (data) => {
        this.isAlive = true;
        try {
          const payload = JSON.parse(data.toString()) as OneBotEvent;
          if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
            return;
          }
          this.emit("message", payload);
        } catch (err) {
          // Ignore parse errors
        }
      });

      this.ws.on("close", () => {
        this.handleDisconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[QQ] WebSocket error:", err);
        this.handleDisconnect();
      });
    } catch (err) {
      console.error("[QQ] Failed to initiate WebSocket connection:", err);
      this.scheduleReconnect();
    }
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // 👇 修改：每 30 秒进行一次严格的主动心跳检测
    this.heartbeatTimer = setInterval(() => {
      if (this.isAlive === false) {
        console.warn("[QQ] Heartbeat timeout, forcing reconnect...");
        this.ws?.terminate(); // 强杀僵尸连接，触发 close 重连
        return;
      }
      this.isAlive = false;
      this.ws?.ping(); // 主动向 NapCat 发送 Ping
    }, 30000); 
  }

  private handleDisconnect() {
    this.cleanup();
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return; // Already scheduled
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts + 1})...`);
    
    this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
    }, delay);
  }

  sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    this.send("send_private_msg", { user_id: userId, message });
  }

  sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    this.send("send_group_msg", { group_id: groupId, message });
  }

  deleteMsg(messageId: number | string) {
    this.send("delete_msg", { message_id: messageId });
  }

  setGroupAddRequest(flag: string, subType: string, approve: boolean = true, reason: string = "") {
    this.send("set_group_add_request", { flag, sub_type: subType, approve, reason });
  }

  setFriendAddRequest(flag: string, approve: boolean = true, remark: string = "") {
    this.send("set_friend_add_request", { flag, approve, remark });
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getMsg(messageId: number | string): Promise<any> {
    return this.sendWithResponse("get_msg", { message_id: messageId });
  }

  async getGroupMsgHistory(groupId: number): Promise<any> {
    return this.sendWithResponse("get_group_msg_history", { group_id: groupId });
  }

  async getForwardMsg(id: string): Promise<any> {
    return this.sendWithResponse("get_forward_msg", { id });
  }

  async getFriendList(): Promise<any[]> {
    return this.sendWithResponse("get_friend_list", {});
  }

  async getGroupList(): Promise<any[]> {
    return this.sendWithResponse("get_group_list", {});
  }

  sendGuildChannelMsg(guildId: string, channelId: string, message: OneBotMessage | string) {
    this.send("send_guild_channel_msg", { guild_id: guildId, channel_id: channelId, message });
  }

  async getGuildList(): Promise<any[]> {
    try {
        return await this.sendWithResponse("get_guild_list", {});
    } catch {
        return [];
    }
  }

  async getGuildServiceProfile(): Promise<any> {
      try { return await this.sendWithResponse("get_guild_service_profile", {}); } catch { return null; }
  }

  sendGroupPoke(groupId: number, userId: number) {
      this.send("group_poke", { group_id: groupId, user_id: userId });
  }

  setGroupBan(groupId: number, userId: number, duration: number = 1800) {
    this.send("set_group_ban", { group_id: groupId, user_id: userId, duration });
  }

  setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false) {
    this.send("set_group_kick", { group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest });
  }

  private sendWithResponse(action: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }

      const echo = Math.random().toString(36).substring(2, 15);
      const handler = (data: WebSocket.RawData) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.echo === echo) {
            this.ws?.off("message", handler);
            if (resp.status === "ok") {
              resolve(resp.data);
            } else {
              reject(new Error(resp.msg || "API request failed"));
            }
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };

      this.ws.on("message", handler);
      this.ws.send(JSON.stringify({ action, params, echo }));

      setTimeout(() => {
        this.ws?.off("message", handler);
        reject(new Error("Request timeout"));
      }, 5000);
    });
  }

  private send(action: string, params: any) {
    const payload = JSON.stringify({ action, params });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // 👇 绝杀改造：哪怕断网了，也不要丢弃消息，而是塞进缓冲队列里！
      console.warn("[QQ] WebSocket not open, queuing message for later delivery...");
      this.outQueue.push(payload);
      
      // 防止断网太久导致内存泄漏，队列最多存 50 条消息
      if (this.outQueue.length > 50) {
          this.outQueue.shift(); 
      }
    }
  }

  disconnect() {
    this.cleanup();
  }
}