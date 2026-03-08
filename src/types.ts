export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; slotKey?: string }): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: emoji reaction on a message.
  addReaction?(jid: string, messageId: string, emojiType: string): Promise<void>;
  // Optional: pre-create a streaming card so the first chunk only needs a content update.
  // keyOrJid can be a slotKey (for per-user isolation) or a plain jid.
  beginStreaming?(keyOrJid: string, opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; startedAt?: number }): Promise<void>;
  // Optional: end a streaming card session (Lark streaming cards).
  endStreaming?(keyOrJid: string, opts?: { isError?: boolean; reasoningText?: string; reasoningElapsedMs?: number }): Promise<void>;
  // Optional: send an image file.
  sendImage?(jid: string, imagePath: string, replyToMessageId?: string): Promise<void>;
  // Optional: send a file.
  sendFile?(jid: string, filePath: string, replyToMessageId?: string): Promise<void>;
  // Optional: edit a previously sent message.
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  // Optional: download a message resource (image/file) to a local path.
  downloadResource?(messageId: string, resourceKey: string, destPath: string): Promise<string>;
  // Optional: fetch chat history from the platform API.
  getChatHistory?(jid: string, count: number, beforeTimestamp?: string): Promise<ChatHistoryMessage[]>;
  // Optional: send an interactive card (buttons, selects, etc.)
  sendCard?(jid: string, cardJson: object, replyToMessageId?: string): Promise<void>;
  // Optional: update (PATCH) an existing card message content.
  updateCard?(jid: string, messageId: string, cardJson: object): Promise<void>;
  // Optional: remove a reaction from a message by reaction ID.
  removeReaction?(jid: string, messageId: string, reactionId: string): Promise<void>;
  // Optional: list reactions on a message (optionally filtered by emoji type).
  listReactions?(jid: string, messageId: string, emojiType?: string): Promise<Array<{ reactionId: string; emojiType: string; operatorType: string; operatorId: string }>>;
  // Optional: forward a message to another chat.
  forwardMessage?(messageId: string, targetJid: string): Promise<void>;
}

export interface ChatHistoryMessage {
  message_id: string;
  sender_id: string;
  sender_type: string; // "user" | "bot" | "app"
  msg_type: string;    // "text" | "post" | "interactive" | "image" | etc.
  content: string;     // parsed text content
  create_time: string; // ISO timestamp
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
